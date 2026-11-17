// The REST v3 API under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON; every
// error carries a string `message`; the caller (app.ts) adds the
// X-GitHub-Request-Id header and the JSON content type.
//
// The handlers share the store's domain logic with GraphQL and MCP, so the
// three surfaces can never disagree about the same objects.

import {
  commitFile,
  deleteFile,
  isOid,
  isoTime,
  listBranches,
  listCommits,
  mergePullRequest,
  pullRequestFiles,
  readPath,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  store: Store;
  method: string;
  /** Decoded path segments after /api/v3 (e.g. ['repos', owner, name, 'issues']). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when the request had no body. */
  body: unknown;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
}

export interface RestReply {
  status: number;
  /** The JSON body (null for a 204). */
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function notFound(what = 'Not Found'): RestReply {
  return err(404, what);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Serializers

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, id: 1 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoTime(repo.createdSeq),
    updated_at: isoTime(repo.createdSeq),
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: store.actorLogin() },
    created_at: isoTime(issue.seq),
    updated_at: isoTime(issue.seq),
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const { headSha, baseSha } = store.pullTips(repo, pull);
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    user: { login: store.actorLogin() },
    created_at: isoTime(pull.seq),
    updated_at: isoTime(pull.seq),
  };
}

// ---------------------------------------------------------------------------
// Pagination: `?page=&per_page=` with a Link rel="next" that stays on this origin.

function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  basePath: string,
  host: string,
): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage >= items.length) return { page: slice, link: null };
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return { page: slice, link: `<http://${host}${basePath}?${next.toString()}>; rel="next"` };
}

// ---------------------------------------------------------------------------
// The router

export function handleRest(req: RestRequest): RestReply {
  const { store, method, segments: s } = req;
  const basePath = `/api/v3/${s.join('/')}`;

  // GET /api/v3/ — the API root, with the token's scopes.
  if ((s.length === 0 || (s.length === 1 && s[0] === '')) && method === 'GET') {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    return ok(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user — the token owner's login (404 until the viewer is learned).
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    if (store.viewerLogin === null) return notFound('Not Found');
    return ok(200, { login: store.viewerLogin, id: 1 });
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.listRepos(), req.query, basePath, req.host);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return ok(200, page.map((repo) => repoJson(store, repo)), headers);
    }
    if (method === 'POST') {
      const name = stringField(req.body, 'name');
      if (name === undefined || name === '') return err(422, 'name is required');
      const description = stringField(req.body, 'description') ?? '';
      const isPrivate = isRecord(req.body) && req.body.private === true;
      const repo = store.createRepo(name, { description, private: isPrivate });
      if (repo === null) return err(422, `Repository ${name} already exists`);
      return ok(201, repoJson(store, repo));
    }
    return notFound();
  }

  // Everything below names a repository: /api/v3/repos/{owner}/{name}[/...].
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1]!;
    const name = s[2]!;
    const repo = store.resolveRepo(owner, name);
    if (repo === null) return notFound('Not Found');
    return handleRepo(req, repo, s.slice(3));
  }

  return notFound();
}

/** The routes under one repository. `rest` is the segments after /repos/{owner}/{name}. */
function handleRepo(req: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { store, method } = req;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const description = stringField(req.body, 'description');
      if (description !== undefined) repo.description = description;
      if (isRecord(req.body) && typeof req.body.private === 'boolean') repo.private = req.body.private;
      return ok(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return ok(204, null);
    }
    return notFound();
  }

  const head = rest[0]!;

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      return ok(200, listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = store.branchTip(repo, branch);
      if (tip === null) return notFound('Branch not found');
      return ok(200, { name: branch, commit: { sha: tip } });
    }
    return notFound();
  }

  // Commits.
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = req.query.get('sha') ?? undefined;
    const commits = listCommits(store, repo, ref);
    if (commits === null) return notFound('No commit found for this ref');
    return ok(
      200,
      commits.map((commit) => {
        const parsed = store.getCommit(repo, commit.sha);
        const author = parseIdent(parsed?.author ?? '');
        const committer = parseIdent(parsed?.committer ?? '');
        return {
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: author.name, email: author.email, date: author.date },
            committer: { name: committer.name, email: committer.email, date: committer.date },
            tree: { sha: commit.tree },
          },
          parents: commit.parents.map((sha) => ({ sha })),
        };
      }),
    );
  }

  // Git Data: refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = stringField(req.body, 'ref');
      const sha = stringField(req.body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
      if (sha === undefined || !isOid(sha)) return err(422, 'sha must be a 40-hex object id');
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      if (ref.startsWith('refs/heads/')) {
        const commit = store.resolveRef(repo, sha);
        if (commit === null) return err(422, `No commit found for SHA: ${sha}`);
        repo.refs.set(ref, commit);
        return ok(201, { ref, object: { sha: commit } });
      }
      if (store.getObject(repo, sha) === undefined) return err(422, `No object found for SHA: ${sha}`);
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const tip = store.branchTip(repo, branch);
      if (tip === null) return notFound('Reference does not exist');
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).join('/');
      const full = `refs/${ref}`;
      const tip = repo.refs.get(full);
      if (tip === undefined) return notFound('Reference does not exist');
      return ok(200, { ref: full, object: { sha: tip } });
    }
    return notFound();
  }

  // Contents.
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = req.query.get('ref') ?? undefined;
      const read = readPath(store, repo, ref, path);
      if (read === null) return notFound('Not Found');
      if (read.kind === 'file') {
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          content: read.content.toString('base64'),
          sha: read.sha,
          size: read.size,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      return ok(200, read.entries);
    }
    if (method === 'PUT') {
      const message = stringField(req.body, 'message') ?? '';
      const contentB64 = stringField(req.body, 'content');
      if (contentB64 === undefined) return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const branch = stringField(req.body, 'branch');
      const sha = stringField(req.body, 'sha');
      const result = commitFile(store, repo, { branch, path, content, message, sha });
      if ('error' in result) {
        if (result.error === 'stale') return err(409, 'The file has changed since the sha was read');
        if (result.error === 'missing-sha') return err(422, 'sha is required to update a file');
        return err(422, 'Not a file path');
      }
      return ok(result.created ? 201 : 200, {
        content: { sha: result.blobSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
    }
    if (method === 'DELETE') {
      const message = stringField(req.body, 'message') ?? '';
      const branch = stringField(req.body, 'branch');
      const sha = stringField(req.body, 'sha');
      const result = deleteFile(store, repo, { branch, path, message, sha });
      if ('error' in result) {
        if (result.error === 'not-found' || result.error === 'no-branch') return notFound('Not Found');
        return err(409, 'The file has changed since the sha was read');
      }
      return ok(200, { commit: { sha: result.commitSha } });
    }
    return notFound();
  }

  return handleIssuesPulls(req, repo, rest);
}

/** Parse an ident line (`Name <email> <epoch> +0000`) into its parts. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: '', email: '', date: '' };
  const epoch = parseInt(match[3]!, 10);
  return {
    name: match[1]!,
    email: match[2]!,
    date: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : '',
  };
}

// ---------------------------------------------------------------------------
// Labels, issues, comments, pull requests.

/** The labels an issue-create body names: strings, or objects with a name. */
function labelNames(body: unknown): string[] | null {
  if (!isRecord(body) || body.labels === undefined) return [];
  if (!Array.isArray(body.labels)) return null;
  const names: string[] = [];
  for (const entry of body.labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function handleIssuesPulls(req: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { store, method } = req;
  const head = rest[0]!;
  const basePath = `/api/v3/repos/${encodeURIComponent(store.viewerLogin ?? '')}/${encodeURIComponent(repo.name)}/${rest.join('/')}`;

  // Labels.
  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const name = stringField(req.body, 'name');
      if (name === undefined || name === '') return err(422, 'name is required');
      const color = stringField(req.body, 'color') ?? 'ededed';
      const label = store.createLabel(repo, name, color);
      return ok(201, { name: label.name, color: label.color });
    }
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return notFound();
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = stringField(req.body, 'title');
        if (title === undefined || title === '') return err(422, 'title is required');
        const body = stringField(req.body, 'body') ?? '';
        const labels = labelNames(req.body);
        if (labels === null) return err(422, 'labels must be an array of names');
        const created = store.createIssue(repo, { title, body, labels });
        if ('badLabel' in created) return err(422, `Label ${created.badLabel} does not exist`);
        return ok(201, issueJson(store, repo, created.issue));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let issues = repo.issues;
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        else if (state !== 'all') return err(422, `state must be open, closed or all`);
        const direction = req.query.get('direction') ?? 'desc';
        const sorted = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { page, link } = paginate(sorted, req.query, basePath, req.host);
        const headers: Record<string, string> = {};
        if (link !== null) headers.link = link;
        return ok(200, page.map((issue) => issueJson(store, repo, issue)), headers);
      }
      return notFound();
    }
    const number = parseInt(rest[1]!, 10);
    if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
    const issue = repo.issueByNumber.get(number);
    if (issue === undefined) return notFound('Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return ok(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const state = stringField(req.body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(req.body, 'title');
        if (title !== undefined) issue.title = title;
        const body = stringField(req.body, 'body');
        if (body !== undefined) issue.body = body;
        return ok(200, issueJson(store, repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const body = stringField(req.body, 'body');
        if (body === undefined || body === '') return err(422, 'body is required');
        const comment = store.addComment(repo, number, body);
        if (comment === null) return notFound('Not Found');
        return ok(201, {
          id: comment.id,
          body: comment.body,
          user: { login: store.actorLogin() },
          created_at: isoTime(comment.seq),
          updated_at: isoTime(comment.seq),
        });
      }
      if (method === 'GET') {
        return ok(
          200,
          store.listComments(repo, number).map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: store.actorLogin() },
            created_at: isoTime(comment.seq),
            updated_at: isoTime(comment.seq),
          })),
        );
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = stringField(req.body, 'title');
        const headRef = stringField(req.body, 'head');
        const baseRef = stringField(req.body, 'base');
        if (title === undefined || title === '') return err(422, 'title is required');
        if (headRef === undefined || headRef === '') return err(422, 'head is required');
        if (baseRef === undefined || baseRef === '') return err(422, 'base is required');
        const body = stringField(req.body, 'body') ?? '';
        const created = store.createPull(repo, { title, body, head: headRef, base: baseRef });
        if ('error' in created) {
          if (created.error === 'no-head') return err(422, `Head branch ${headRef} does not exist`);
          if (created.error === 'no-base') return err(422, `Base branch ${baseRef} does not exist`);
          return err(422, 'A pull request already exists for this head branch');
        }
        return ok(201, pullJson(store, repo, created.pull));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let pulls = repo.pulls;
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        else if (state !== 'all') return err(422, 'state must be open, closed or all');
        const sorted = [...pulls].sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(sorted, req.query, basePath, req.host);
        const headers: Record<string, string> = {};
        if (link !== null) headers.link = link;
        return ok(200, page.map((pull) => pullJson(store, repo, pull)), headers);
      }
      return notFound();
    }
    const number = parseInt(rest[1]!, 10);
    if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
    const pull = repo.pullByNumber.get(number);
    if (pull === undefined) return notFound('Not Found');
    if (rest.length === 2 && method === 'GET') {
      return ok(200, pullJson(store, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return ok(200, pullRequestFiles(store, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const result = mergePullRequest(store, repo, number);
      if ('error' in result) {
        if (result.error === 'not-found') return notFound('Not Found');
        if (result.error === 'already') return err(405, 'Pull Request is already merged or closed');
        return err(405, 'Pull Request is not mergeable');
      }
      return ok(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}
