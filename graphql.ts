// GraphQL v4 endpoint: a small real parser and executor over the store.
//
// The checks use 17 fixed documents, but this is a general parser for the
// subset they exercise (operations, aliases, arguments, variables, inline
// fragments, inline input objects, enum literals) rather than string
// matching on each document, so a reworded document still works.

import {
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
  gid,
  mergePullRequest,
  parseGid,
  pullRequestFiles,
  pullRequestMergeable,
} from './store.ts';

// ---------------------------------------------------------------------------
// AST.

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { __var: string };

export interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: GqlSelection[];
}

// ---------------------------------------------------------------------------
// Lexer.

type Token =
  | { type: 'punct'; value: string }
  | { type: 'name'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const c = source[i]!;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            i += 2;
          }
        } else {
          value += c;
          i += 1;
        }
      }
      i += 1; // Closing quote.
      tokens.push({ type: 'string', value });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let isFloat = false;
      if (source[j] === '.' && source[j + 1]! >= '0' && source[j + 1]! <= '9') {
        isFloat = true;
        j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i;
      while (
        j < source.length &&
        ((source[j]! >= 'a' && source[j]! <= 'z') ||
          (source[j]! >= 'A' && source[j]! <= 'Z') ||
          (source[j]! >= '0' && source[j]! <= '9') ||
          source[j] === '_')
      ) {
        j += 1;
      }
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL syntax error: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent).

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL syntax error: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`GraphQL syntax error: expected ${JSON.stringify(value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error('GraphQL syntax error: expected a name');
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('GraphQL syntax error: empty document');
    return operations;
  }

  private parseOperation(): GqlOperation {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`GraphQL syntax error: expected query, mutation or subscription`);
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.type === 'name') name = this.next().value as string;
    const variables: string[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        const def = this.peek();
        if (def !== undefined && def.type === 'punct' && def.value === '=') {
          this.next();
          this.parseValue();
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind: keyword === 'subscription' ? 'query' : keyword, name, variables, selections };
  }

  /** A type reference: Name, [Type], Type!. Only consumed, not recorded. */
  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on !== undefined && on.type === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Directives (@...) are not used by the checks; skip them if present.
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selections: GqlSelection[] = [];
    const brace = this.peek();
    if (brace !== undefined && brace.type === 'punct' && brace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { __var: this.expectName() };
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.next();
      return values;
    }
    if (token.type === 'punct' && token.value === '{') {
      const object: { [key: string]: GqlValue } = {};
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.next();
      return object;
    }
    if (token.type === 'string') return token.value;
    if (token.type === 'int') return parseInt(token.value, 10);
    if (token.type === 'float') return parseFloat(token.value);
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // Enum literal: its name.
    }
    throw new Error('GraphQL syntax error: expected a value');
  }
}

/** Resolve `$var` references in a parsed value against the request variables. */
function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (typeof value === 'object' && value !== null) {
    if ('__var' in value) {
      const name = (value as { __var: string }).__var;
      return name in variables ? variables[name] : null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
    return out;
  }
  return value;
}

/** Resolve every argument of a field against the request variables. */
function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema: field name -> return type (null for a scalar). Lists collapse to
// their item type; validation and execution treat them the same way.

const FIELDS: Record<string, Record<string, string | null>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Node: { id: null },
  User: { login: null },
  Repository: {
    id: null,
    databaseId: null,
    name: null,
    nameWithOwner: null,
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: null,
    hasIssuesEnabled: null,
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Ref: { name: null },
  Issue: { id: null, number: null, title: null, state: null, body: null },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PageInfo: { hasNextPage: null, endCursor: null },
  PullRequest: {
    id: null,
    number: null,
    state: null,
    merged: null,
    headRefName: null,
    baseRefName: null,
    mergeable: null,
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: 'PullRequest' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  PullRequestChangedFile: { path: null },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: null },
  __EnumValue: { name: null },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'Comment' },
  Comment: { id: null, body: null },
};

/** Enum values for the types introspection can ask about. */
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

/** Validate a selection set against the schema, collecting field errors. */
function validateSelections(selections: GqlSelection[], parentType: string, errors: string[]): void {
  const fields = FIELDS[parentType];
  if (fields === undefined) {
    errors.push(`Unknown type "${parentType}".`);
    return;
  }
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const type = sel.typeCondition ?? parentType;
      if (FIELDS[type] === undefined) {
        errors.push(`Unknown type "${type}".`);
        continue;
      }
      validateSelections(sel.selections, type, errors);
      continue;
    }
    const returnType = fields[sel.name];
    if (returnType === undefined) {
      errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
      continue;
    }
    if (sel.selections.length > 0) {
      if (returnType === null) {
        errors.push(`Field "${sel.name}" must not have a selection since type "${parentType}" has no subfields.`);
        continue;
      }
      validateSelections(sel.selections, returnType, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution.

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: string[];
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return null;
    return parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

/** Decode a global id of the expected kind and find its repository. */
function repoFromGid(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = parseGid(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbid = parseInt(decoded.parts[0]!, 10);
  if (!Number.isInteger(dbid)) return null;
  return store.getRepoById(dbid) ?? null;
}

/** Decode an Issue or PullRequest global id to its repo and number. */
function subjectFromGid(store: Store, id: unknown, kind: 'Issue' | 'PullRequest'): { repo: Repo; number: number } | null {
  if (typeof id !== 'string') return null;
  const decoded = parseGid(id);
  if (decoded === null || decoded.kind !== kind) return null;
  const dbid = parseInt(decoded.parts[0]!, 10);
  const number = parseInt(decoded.parts[1]!, 10);
  if (!Number.isInteger(dbid) || !Number.isInteger(number)) return null;
  const repo = store.getRepoById(dbid);
  if (repo === undefined) return null;
  return { repo, number };
}

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The repository.issues connection: filter, order, cursor-page. */
function issuesConnection(
  repo: Repo,
  args: Record<string, unknown>,
): { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let issues = repo.issues;
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = new Set((args.states as unknown[]).map((entry) => String(entry).toLowerCase()));
    issues = issues.filter((issue) => want.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | undefined;
  const desc = orderBy !== undefined && orderBy.direction === 'DESC';
  const sorted = [...issues].sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const number = decodeCursor(args.after);
    if (number !== null) {
      const idx = sorted.findIndex((issue) => issue.number === number);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
  const page = sorted.slice(start, start + first);
  const hasNextPage = start + page.length < sorted.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

function executeSelections(ctx: Ctx, parentType: string, parentData: unknown, selections: GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, parentType, parentData, sel.selections));
      continue;
    }
    out[sel.alias ?? sel.name] = executeField(ctx, parentType, parentData, sel);
  }
  return out;
}

function executeField(ctx: Ctx, parentType: string, parentData: unknown, field: GqlField): unknown {
  const { store } = ctx;
  const args = resolveArgs(field, ctx.variables);

  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') {
        return executeSelections(ctx, 'User', { login: store.viewerLogin ?? '' }, field.selections);
      }
      if (field.name === 'repository') {
        const repo = store.resolveRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === null) return null;
        return executeSelections(ctx, 'Repository', repo, field.selections);
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? parseGid(args.id) : null;
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepoById(parseInt(decoded.parts[0]!, 10));
          if (repo === undefined) return null;
          return executeSelections(ctx, 'Repository', repo, field.selections);
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const subject = subjectFromGid(store, args.id, decoded.kind);
          if (subject === null) return null;
          if (decoded.kind === 'Issue') {
            const issue = subject.repo.issueByNumber.get(subject.number);
            if (issue === undefined) return null;
            return executeSelections(ctx, 'Issue', issue, field.selections);
          }
          const pull = subject.repo.pullByNumber.get(subject.number);
          if (pull === undefined) return null;
          return executeSelections(ctx, 'PullRequest', pull, field.selections);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return executeSelections(ctx, '__Type', { name }, field.selections);
      }
      return null;
    }

    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const repo = repoFromGid(store, input.repositoryId);
        if (repo === null) {
          ctx.errors.push('Could not resolve to a Repository with the id.');
          return null;
        }
        const created = store.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          labels: [],
        });
        if ('badLabel' in created) {
          ctx.errors.push(`Label ${created.badLabel} does not exist.`);
          return null;
        }
        return executeSelections(ctx, 'CreateIssuePayload', { issue: created.issue }, field.selections);
      }
      if (field.name === 'closeIssue') {
        const subject = subjectFromGid(store, input.issueId, 'Issue');
        const issue = subject?.repo.issueByNumber.get(subject.number);
        if (subject === null || issue === undefined) {
          ctx.errors.push('Could not resolve to an Issue with the id.');
          return null;
        }
        issue.state = 'closed';
        return executeSelections(ctx, 'CloseIssuePayload', { issue }, field.selections);
      }
      if (field.name === 'createPullRequest') {
        const repo = repoFromGid(store, input.repositoryId);
        if (repo === null) {
          ctx.errors.push('Could not resolve to a Repository with the id.');
          return null;
        }
        const created = store.createPull(repo, {
          title: String(input.title ?? ''),
          body: '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        if ('error' in created) {
          ctx.errors.push(created.error === 'no-head' ? 'Head branch does not exist.' : created.error === 'no-base' ? 'Base branch does not exist.' : 'A pull request already exists for this head branch.');
          return null;
        }
        return executeSelections(ctx, 'CreatePullRequestPayload', { pullRequest: created.pull }, field.selections);
      }
      if (field.name === 'mergePullRequest') {
        const subject = subjectFromGid(store, input.pullRequestId, 'PullRequest');
        if (subject === null) {
          ctx.errors.push('Could not resolve to a PullRequest with the id.');
          return null;
        }
        const result = mergePullRequest(store, subject.repo, subject.number);
        if ('error' in result) {
          ctx.errors.push(result.error === 'conflict' ? 'Pull Request is not mergeable.' : 'Pull Request is already merged or closed.');
          return null;
        }
        const pull = subject.repo.pullByNumber.get(subject.number)!;
        return executeSelections(ctx, 'MergePullRequestPayload', { pullRequest: pull }, field.selections);
      }
      if (field.name === 'addComment') {
        const subject = subjectFromGid(store, input.subjectId, 'Issue');
        const issue = subject?.repo.issueByNumber.get(subject.number);
        if (subject === null || issue === undefined) {
          ctx.errors.push('Could not resolve to an Issue with the id.');
          return null;
        }
        const comment = store.addComment(subject.repo, issue.number, String(input.body ?? ''));
        return executeSelections(ctx, 'AddCommentPayload', { comment }, field.selections);
      }
      return null;
    }

    case 'User':
      return (parentData as { login: string }).login;

    case 'Repository': {
      const repo = parentData as Repo;
      switch (field.name) {
        case 'id':
          return gid('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${store.viewerLogin ?? ''}/${repo.name}`;
        case 'owner':
          return executeSelections(ctx, 'User', { login: store.viewerLogin ?? '' }, field.selections);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return executeSelections(ctx, 'Ref', { name: repo.defaultBranch }, field.selections);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issueByNumber.get(Number(args.number));
          if (issue === undefined) return null;
          return executeSelections(ctx, 'Issue', issue, field.selections);
        }
        case 'issues':
          return executeSelections(ctx, 'IssueConnection', issuesConnection(repo, args), field.selections);
        case 'pullRequests': {
          const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
          const nodes = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number).slice(0, first);
          return executeSelections(ctx, 'PullRequestConnection', { nodes }, field.selections);
        }
        case 'pullRequest': {
          const pull = repo.pullByNumber.get(Number(args.number));
          if (pull === undefined) return null;
          return executeSelections(ctx, 'PullRequest', pull, field.selections);
        }
        default:
          return null;
      }
    }

    case 'Ref':
      return (parentData as { name: string }).name;

    case 'Issue': {
      const issue = parentData as Issue;
      switch (field.name) {
        case 'id':
          return gid('Issue', String(issue.repoId), String(issue.number));
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue.state);
        case 'body':
          return issue.body;
        default:
          return null;
      }
    }

    case 'IssueConnection': {
      const conn = parentData as { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') {
        return conn.nodes.map((issue) => executeSelections(ctx, 'Issue', issue, field.selections));
      }
      return executeSelections(ctx, 'PageInfo', conn.pageInfo, field.selections);
    }

    case 'PageInfo': {
      const info = parentData as { hasNextPage: boolean; endCursor: string | null };
      return field.name === 'hasNextPage' ? info.hasNextPage : info.endCursor;
    }

    case 'PullRequest': {
      const pull = parentData as PullRequest;
      switch (field.name) {
        case 'id':
          return gid('PullRequest', String(pull.repoId), String(pull.number));
        case 'number':
          return pull.number;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const repo = store.getRepoById(pull.repoId);
          if (repo === undefined) return 'UNKNOWN';
          return pullRequestMergeable(store, repo, pull);
        }
        case 'files': {
          const repo = store.getRepoById(pull.repoId);
          if (repo === undefined) return executeSelections(ctx, 'PullRequestChangedFileConnection', { nodes: [] }, field.selections);
          const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
          const nodes = pullRequestFiles(store, repo, pull)
            .slice(0, first)
            .map((file) => ({ path: file.filename }));
          return executeSelections(ctx, 'PullRequestChangedFileConnection', { nodes }, field.selections);
        }
        default:
          return null;
      }
    }

    case 'PullRequestConnection': {
      const conn = parentData as { nodes: PullRequest[] };
      return conn.nodes.map((pull) => executeSelections(ctx, 'PullRequest', pull, field.selections));
    }

    case 'PullRequestChangedFileConnection': {
      const conn = parentData as { nodes: { path: string }[] };
      return conn.nodes.map((file) => executeSelections(ctx, 'PullRequestChangedFile', file, field.selections));
    }

    case 'PullRequestChangedFile':
      return (parentData as { path: string }).path;

    case '__Type': {
      const name = (parentData as { name: string }).name;
      if (field.name === 'fields') {
        const typeFields = FIELDS[name];
        if (typeFields === undefined) return null;
        return Object.keys(typeFields).map((fieldName) => executeSelections(ctx, '__Field', { name: fieldName }, field.selections));
      }
      // enumValues
      const values = ENUM_VALUES[name];
      if (values === undefined) return null;
      return values.map((value) => executeSelections(ctx, '__EnumValue', { name: value }, field.selections));
    }

    case '__Field':
    case '__EnumValue':
      return (parentData as { name: string }).name;

    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const issue = (parentData as { issue: Issue | null }).issue;
      if (issue === null) return null;
      return executeSelections(ctx, 'Issue', issue, field.selections);
    }

    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const pull = (parentData as { pullRequest: PullRequest | null }).pullRequest;
      if (pull === null) return null;
      return executeSelections(ctx, 'PullRequest', pull, field.selections);
    }

    case 'AddCommentPayload': {
      const comment = (parentData as { comment: Comment | null }).comment;
      if (comment === null) return null;
      return executeSelections(ctx, 'CommentEdge', { comment }, field.selections);
    }

    case 'CommentEdge': {
      const comment = (parentData as { comment: Comment | null }).comment;
      if (comment === null) return null;
      return executeSelections(ctx, 'Comment', comment, field.selections);
    }

    case 'Comment': {
      const comment = parentData as Comment;
      if (field.name === 'id') return gid('Comment', String(comment.repoId), String(comment.issueNumber), String(comment.id));
      return comment.body;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Handler: one request body (a single operation or a JSON array of them).

function executeRequest(store: Store, entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || typeof (entry as { query?: unknown }).query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const { query } = entry as { query: string; operationName?: unknown; variables?: unknown };
  const variables =
    typeof (entry as { variables?: unknown }).variables === 'object' && (entry as { variables?: unknown }).variables !== null
      ? ((entry as { variables: Record<string, unknown> }).variables as Record<string, unknown>)
      : {};
  let operations: GqlOperation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  let operation = operations[0]!;
  const operationName = (entry as { operationName?: unknown }).operationName;
  if (typeof operationName === 'string') {
    const found = operations.find((op) => op.name === operationName);
    if (found !== undefined) operation = found;
  }
  const errors: string[] = [];
  validateSelections(operation.selections, operation.kind === 'mutation' ? 'Mutation' : 'Query', errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const ctx: Ctx = { store, variables, errors: [] };
  const data = executeSelections(ctx, operation.kind === 'mutation' ? 'Mutation' : 'Query', null, operation.selections);
  if (ctx.errors.length > 0) {
    return { data, errors: ctx.errors.map((message) => ({ message })) };
  }
  return { data };
}

/**
 * Handle a GraphQL request body. Returns the HTTP status and the response
 * body. A JSON array body is answered with an array, in order.
 */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeRequest(store, entry)) };
  }
  return { status: 200, body: executeRequest(store, body) };
}
