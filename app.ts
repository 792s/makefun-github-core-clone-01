// The HTTP server: routing, auth, body parsing, response headers. One store
// for the whole trial, shared by REST, GraphQL, MCP and the git endpoints, so
// the surfaces can never disagree about the same objects.
//
// Auth: when MAKEFUN_SHOP_TOKEN is set, every route except /healthz requires
// `Authorization: Bearer <token>`. When it is unset (local development only),
// the server answers without auth.
//
// Every reply carries a non-empty X-GitHub-Request-Id (a deterministic
// counter), and every JSON reply is application/json, including errors.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV0,
  advertisementV2,
  handleReceivePack,
  handleUploadPack,
  RECEIVE_ADVERTISEMENT_TYPE,
  RECEIVE_RESULT_TYPE,
  UPLOAD_ADVERTISEMENT_TYPE,
  UPLOAD_RESULT_TYPE,
} from './git.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** A request body larger than this is refused (packs in the suite are far smaller). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The deterministic request-id counter (no wall clock, no randomness). */
let requestSeq = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = `req-${(requestSeq += 1)}`;
  res.setHeader('x-github-request-id', requestId);

  const send = (status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extra });
    res.end(body);
  };
  const json = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
    // Hand the string to res.end directly: Buffer.from would allocate a copy.
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...extra,
    });
    res.end(payload);
  };

  const method = req.method ?? 'GET';
  // Parse the request target by hand: `new URL` is needlessly slow on the
  // hot path, and the entry only ever sees origin-form targets (absolute
  // form is stripped defensively, for a proxy that forwards it that way).
  let target = req.url ?? '/';
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const slash = target.indexOf('/', target.indexOf('://') + 3);
    target = slash >= 0 ? target.slice(slash) : '/';
  }
  const queryIndex = target.indexOf('?');
  const path = queryIndex >= 0 ? target.slice(0, queryIndex) : target;
  const query = new URLSearchParams(queryIndex >= 0 ? target.slice(queryIndex + 1) : '');

  // The health check takes no auth.
  if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    json(200, { ok: true });
    return;
  }

  if (TOKEN !== '') {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${TOKEN}`) {
      json(401, { message: 'Bad credentials' });
      return;
    }
  }

  const rawSegments = path.split('/').filter((segment) => segment !== '');
  let segments: string[];
  try {
    // Most segments carry no escapes; only decode the ones that do.
    segments = rawSegments.map((segment) => (segment.includes('%') ? decodeURIComponent(segment) : segment));
  } catch {
    json(400, { message: 'Malformed URL' });
    return;
  }

  // -- REST v3 ---------------------------------------------------------------
  if (segments[0] === 'api' && segments[1] === 'v3') {
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          json(400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const reply = handleRest({
      store,
      method,
      segments: segments.slice(2),
      query,
      body,
      host: req.headers.host ?? 'localhost',
    });
    json(reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // -- GraphQL v4 ------------------------------------------------------------
  if (path === '/api/graphql' && method === 'POST') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      json(400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const result = handleGraphQL(store, body);
    json(result.status, result.body);
    return;
  }

  // -- MCP -------------------------------------------------------------------
  if (path === '/mcp' && method === 'POST') {
    const raw = await readBody(req);
    let body: unknown = null;
    let valid = raw.length > 0;
    if (valid) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        valid = false;
      }
    }
    const result = handleMcp(store, body, valid);
    if (result.body === null) {
      // A notification: 202 with no body.
      res.writeHead(result.status, { 'content-length': 0 });
      res.end();
      return;
    }
    json(result.status, result.body);
    return;
  }

  // -- Git smart HTTP --------------------------------------------------------
  // /{owner}/{repo}.git/info/refs (4 segments) or .../git-upload-pack and
  // .../git-receive-pack (3 segments).
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const endpoint = segments.slice(2).join('/');
    const repo = store.resolveRepo(owner, repoName);
    if (repo === null) {
      json(404, { message: 'Not Found' });
      return;
    }
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        const proto = req.headers['git-protocol'];
        const protoText = Array.isArray(proto) ? proto.join(',') : (proto ?? '');
        const body = protoText.includes('version=2')
          ? advertisementV2()
          : advertisementV0(store, repo, 'git-upload-pack');
        send(200, body, UPLOAD_ADVERTISEMENT_TYPE);
        return;
      }
      if (service === 'git-receive-pack') {
        send(200, advertisementV0(store, repo, 'git-receive-pack'), RECEIVE_ADVERTISEMENT_TYPE);
        return;
      }
      json(400, { message: 'service is required' });
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      try {
        send(200, handleUploadPack(store, repo, raw), UPLOAD_RESULT_TYPE);
      } catch (err) {
        json(400, { message: err instanceof Error ? err.message : 'Bad request' });
      }
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      try {
        send(200, handleReceivePack(store, repo, raw), RECEIVE_RESULT_TYPE);
      } catch (err) {
        json(400, { message: err instanceof Error ? err.message : 'Bad request' });
      }
      return;
    }
    json(404, { message: 'Not Found' });
    return;
  }

  // -- Everything else: a JSON 404, never HTML. -------------------------------
  json(404, { message: 'Not Found' });
}

/** Build the server. The caller binds it (main.ts binds an ephemeral port). */
export function createApp(): Server {
  const store = new Store();
  return createServer((req, res) => {
    handleRequest(store, req, res).catch((err) => {
      // A handler threw: answer a JSON 500 rather than hanging the connection.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }));
      } else {
        res.destroy();
      }
    });
  });
}
