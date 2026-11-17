// MCP endpoint: JSON-RPC 2.0 over streamable HTTP (plain JSON replies).
//
// Six tools, named after the canonical github-mcp-server tool names. The
// checks read both the text blocks and the structured content of tool
// results, so every call returns both. tools/list is deterministic: the same
// bytes on every call.

import {
  type Repo,
  type Store,
  mergePullRequest,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tool table.

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'The state of the issues: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The name of the branch with the changes.' },
      base: { type: 'string', description: 'The name of the branch to merge into.' },
      body: { type: 'string', description: 'The body of the pull request.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The number of the pull request.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing.

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A tool result: the same payload as a text block and as structured content. */
function toolResult(id: RpcId, payload: unknown): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  });
}

/** A tool failure reported inside a result (isError), keeping HTTP 200. */
function toolFailure(id: RpcId, message: string): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  });
}

// ---------------------------------------------------------------------------
// Argument helpers. The checks pass canonical names, but the client maps a
// few synonyms (owner_login, full_name); accept them where they are obvious.

function argString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argNumber(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  }
  return undefined;
}

function argBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Split a "owner/repo" full name, or read the two fields separately. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const full = argString(args, 'full_name', 'fullName');
  if (full !== undefined) {
    const parts = full.split('/');
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      return { owner: parts[0]!, repo: parts[1]! };
    }
  }
  const owner = argString(args, 'owner', 'owner_login');
  const repo = argString(args, 'repo', 'repository', 'name');
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Tool implementations.

function repoSummary(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: Store, id: RpcId, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === undefined) return rpcError(id, -32602, 'create_repo requires a name argument');
      const description = argString(args, 'description') ?? '';
      const isPrivate = argBoolean(args, 'private') ?? false;
      const repo = store.createRepo(repoName, { private: isPrivate, description });
      if (repo === null) {
        return toolFailure(id, `Repository ${repoName} already exists`);
      }
      return toolResult(id, repoSummary(store, repo));
    }

    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return rpcError(id, -32602, 'get_repo requires owner and repo arguments');
      const repo = store.resolveRepo(target.owner, target.repo);
      if (repo === null) return toolFailure(id, `Repository ${target.owner}/${target.repo} not found`);
      return toolResult(id, repoSummary(store, repo));
    }

    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      const title = argString(args, 'title');
      if (target === null || title === undefined) {
        return rpcError(id, -32602, 'create_issue requires owner, repo and title arguments');
      }
      const repo = store.resolveRepo(target.owner, target.repo);
      if (repo === null) return toolFailure(id, `Repository ${target.owner}/${target.repo} not found`);
      const body = argString(args, 'body') ?? '';
      const labels = Array.isArray(args.labels)
        ? (args.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
      const created = store.createIssue(repo, { title, body, labels });
      if ('badLabel' in created) return toolFailure(id, `Label ${created.badLabel} does not exist`);
      const issue = created.issue;
      return toolResult(id, {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
      });
    }

    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return rpcError(id, -32602, 'list_issues requires owner and repo arguments');
      const repo = store.resolveRepo(target.owner, target.repo);
      if (repo === null) return toolFailure(id, `Repository ${target.owner}/${target.repo} not found`);
      const state = argString(args, 'state') ?? 'open';
      let issues = repo.issues;
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const items = issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
      }));
      return toolResult(id, items);
    }

    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (target === null || title === undefined || head === undefined || base === undefined) {
        return rpcError(id, -32602, 'create_pull_request requires owner, repo, title, head and base arguments');
      }
      const repo = store.resolveRepo(target.owner, target.repo);
      if (repo === null) return toolFailure(id, `Repository ${target.owner}/${target.repo} not found`);
      const body = argString(args, 'body') ?? '';
      const created = store.createPull(repo, { title, body, head, base });
      if ('error' in created) {
        if (created.error === 'no-head') return toolFailure(id, `Head branch ${head} does not exist`);
        if (created.error === 'no-base') return toolFailure(id, `Base branch ${base} does not exist`);
        return toolFailure(id, 'A pull request already exists for this head branch');
      }
      const pull = created.pull;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
      return toolResult(id, {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: headTip },
        base: { ref: pull.baseRef, sha: baseTip },
      });
    }

    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      const pullNumber = argNumber(args, 'pull_number', 'pullNumber', 'number');
      if (target === null || pullNumber === undefined) {
        return rpcError(id, -32602, 'merge_pull_request requires owner, repo and pull_number arguments');
      }
      const repo = store.resolveRepo(target.owner, target.repo);
      if (repo === null) return toolFailure(id, `Repository ${target.owner}/${target.repo} not found`);
      const result = mergePullRequest(store, repo, pullNumber);
      if ('error' in result) {
        if (result.error === 'not-found') return toolFailure(id, `Pull request ${pullNumber} not found`);
        if (result.error === 'already') return toolFailure(id, 'Pull Request is already merged or closed');
        return toolFailure(id, 'Pull Request is not mergeable');
      }
      return toolResult(id, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    }

    default:
      return rpcError(id, -32601, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Handler. The body arrives already parsed (or as a parse failure, which the
// caller reports as a -32700 error). Returns the HTTP status and the JSON
// body to send; a null body means "202 with no body" (notifications).

export function handleMcp(
  store: Store,
  body: unknown,
  bodyValid: boolean,
): { status: number; body: unknown | null } {
  if (!bodyValid) {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id: RpcId =
    typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const params =
    typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};

  switch (request.method) {
    case 'server/discover': {
      const serverInfo = { name: 'forge-mcp', version: '1.0.0' };
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
      };
    }

    case 'initialize': {
      const serverInfo = { name: 'forge-mcp', version: '1.0.0' };
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo,
        }),
      };
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications carry no id and get no body.
      return { status: 202, body: null };

    case 'tools/list':
      return { status: 200, body: rpcResult(id, toolsListResult()) };

    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string') {
        return { status: 200, body: rpcError(id, -32602, 'tools/call requires a name') };
      }
      const args =
        typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      return { status: 200, body: callTool(store, id, toolName, args) };
    }

    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };

    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${request.method}`) };
  }
}
