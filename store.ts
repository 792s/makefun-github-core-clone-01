// The forge's store: every repository, git object, ref, issue, pull request,
// label and comment lives here, in memory, behind one Store. This module also
// holds the git object model (hashing, tree/commit/tag parse and build) and
// the domain logic every surface shares (REST, GraphQL and MCP all call the
// same methods, so the three views can never disagree).
//
// Determinism: commit timestamps come from a counter on a fixed epoch, never
// from the wall clock, so two runs of the same request sequence build the
// same object ids. The only wall-clock-free timestamps in the store are the
// ISO dates derived from that same counter.

import { createHash } from 'node:crypto';

/** The all-zero object id: an unborn ref's old/new value. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** Every repository's default branch. The suite's scenario uses 'main' throughout. */
export const DEFAULT_BRANCH = 'main';
/** The empty tree's id (SHA-1 of `tree 0\0`). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** The epoch commit timestamps count from (2023-11-14T22:13:20Z). */
const COMMIT_EPOCH = 1_700_000_000;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The git object id: SHA-1 over `<type> <size>\0<bytes>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

/** Whether `value` is a 40-hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  /** '100644' file, '100755' executable, '40000' directory, '120000' symlink. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid, repeated). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** A tree entry's sort key: git compares a directory as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries, sorted git-style. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Commits and tags

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object: `tree`, `parent`* lines, author/committer, blank line, message. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored exactly as given. */
export function buildCommit(commit: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let header = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) header += `parent ${parent}\n`;
  header += `author ${commit.author}\ncommitter ${commit.committer}\n\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(commit.message, 'utf8')]);
}

export interface ParsedTag {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: base64url of `Kind:parts`, opaque and stable.

/** Encode a global id. Never the plain database id or number. */
export function gid(kind: string, ...parts: string[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

/** Decode a global id, or null when it is not one of ours. */
export function parseGid(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    // A re-encode must round-trip, so a stray base64 string is not a global id.
    if (gid(kind, ...parts) !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** An ISO timestamp derived from the deterministic counter (no wall clock). */
const isoCache = new Map<number, string>();
export function isoTime(seq: number): string {
  const cached = isoCache.get(seq);
  if (cached !== undefined) return cached;
  const text = new Date((COMMIT_EPOCH + seq) * 1000).toISOString();
  isoCache.set(seq, text);
  return text;
}

// ---------------------------------------------------------------------------
// Records

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  /** The global numeric id REST reports (stable across reads). */
  id: number;
  /** The repository's database id (for the global id). */
  repoId: number;
  /** The cached global (Relay) id, computed once at creation. */
  nodeId: string;
  /** The per-repository number, from 1. */
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Creation order within the repository (the sort key). */
  seq: number;
}

export interface Comment {
  id: number;
  /** The repository's database id and the issue number (for the global id). */
  repoId: number;
  issueNumber: number;
  body: string;
  seq: number;
}

export interface PullRequest {
  id: number;
  /** The repository's database id (for the global id). */
  repoId: number;
  /** The cached global (Relay) id, computed once at creation. */
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The branch tips at creation, a fallback when a ref is later deleted. */
  headShaAtCreation: string;
  baseShaAtCreation: string;
  seq: number;
}

export interface Repo {
  /** The numeric database id (GraphQL `databaseId`, REST `id`). */
  id: number;
  /** The cached global (Relay) id, computed once at creation. */
  nodeId: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** All git objects by id. */
  objects: Map<string, GitObject>;
  /** Ref name -> tip oid (refs/heads/*, refs/tags/*). */
  refs: Map<string, string>;
  /** Parsed commits and trees, cached by id (objects are immutable). */
  commitCache: Map<string, ParsedCommit>;
  treeCache: Map<string, TreeEntry[]>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  issueSeq: number;
  pulls: PullRequest[];
  pullByNumber: Map<number, PullRequest>;
  pullSeq: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  createdSeq: number;
}

/** The store: every repository under the one token owner, plus the viewer login. */
export class Store {
  /** Repositories by name. One token owner, so the name is the whole key. */
  readonly repos = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  /** The token owner's login, learned from the first request naming a repository's owner. */
  viewerLogin: string | null = null;
  private repoSeq = 0;
  private issueIdSeq = 0;
  private pullIdSeq = 0;
  private commentIdSeq = 0;
  /** The commit timestamp counter (COMMIT_EPOCH + this). */
  private commitSeq = 0;
  private seq = 0;

  /** The next creation-order number. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The login to sign commits and comments with (the viewer once learned). */
  actorLogin(): string {
    return this.viewerLogin ?? 'forge';
  }

  /** The author/committer line for a commit the forge itself writes. */
  private identity(): { name: string; email: string } {
    const login = this.actorLogin();
    return { name: login, email: `${login}@users.noreply.github.com` };
  }

  /** The next commit timestamp (seconds since the epoch), deterministic. */
  private nextCommitTime(): number {
    this.commitSeq += 1;
    return COMMIT_EPOCH + this.commitSeq;
  }

  // -- repositories ----------------------------------------------------------

  /** Create a repository, or null when the name is taken. */
  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      nodeId: gid('Repository', String(this.repoSeq)),
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
      issues: [],
      issueByNumber: new Map(),
      issueSeq: 0,
      pulls: [],
      pullByNumber: new Map(),
      pullSeq: 0,
      labels: new Map(),
      comments: new Map(),
      createdSeq: this.nextSeq(),
    };
    this.repos.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (repo === undefined) return false;
    this.repos.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  /** Every repository, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /**
   * Resolve a repository under an owner path. The first request that names an
   * existing repository's owner teaches the forge the viewer login; after
   * that, any other owner is a 404, never a 403. A missing repository is a
   * 404 and teaches nothing.
   */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (this.viewerLogin === null) this.viewerLogin = owner;
    if (owner !== this.viewerLogin) return null;
    return repo;
  }

  // -- git objects -----------------------------------------------------------

  /** Store an object, returning its id. A duplicate is a no-op. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** A commit's parsed form, cached. */
  getCommit(repo: Repo, oid: string): ParsedCommit | null {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  /** A tree's entries, cached. */
  getTree(repo: Repo, oid: string): TreeEntry[] | null {
    const cached = repo.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    repo.treeCache.set(oid, parsed);
    return parsed;
  }

  /** A tag's parsed form (not cached: tags are rare). */
  getTag(repo: Repo, oid: string): ParsedTag | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tag') return null;
    return parseTag(object.data);
  }

  /** Resolve a ref name (branch, tag, or a full oid) to a commit id, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === '' || ref === 'HEAD') ref = repo.defaultBranch;
    // A full object id names the commit (or a tag that peels to one).
    if (isOid(ref)) {
      const object = repo.objects.get(ref);
      if (object === undefined) return null;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') {
        const tag = parseTag(object.data);
        return this.resolveRef(repo, tag.object);
      }
      return null;
    }
    const direct = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (direct === undefined) return null;
    const object = repo.objects.get(direct);
    if (object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      return this.resolveRef(repo, tag.object);
    }
    return direct;
  }

  /** The tip of a branch, or null when the branch has no commit. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Write a commit object and return its id. */
  writeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const { name, email } = this.identity();
    const when = this.nextCommitTime();
    const stamp = `${name} <${email}> ${when} +0000`;
    const data = buildCommit({ tree, parents, author: stamp, committer: stamp, message });
    return this.putObject(repo, 'commit', data);
  }

  // -- issues, labels, comments ----------------------------------------------

  /** Create a label, or the existing one when the name is taken. */
  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; `badLabel` names a label that does not exist. */
  createIssue(
    repo: Repo,
    input: { title: string; body?: string; labels?: readonly string[] },
  ): { issue: Issue } | { badLabel: string } {
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) return { badLabel: name };
      labels.push(label);
    }
    this.issueIdSeq += 1;
    repo.issueSeq += 1;
    const issue: Issue = {
      id: this.issueIdSeq,
      repoId: repo.id,
      nodeId: gid('Issue', String(repo.id), String(repo.issueSeq)),
      number: repo.issueSeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      seq: this.nextSeq(),
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return { issue };
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = repo.issueByNumber.get(issueNumber);
    if (issue === undefined) return null;
    this.commentIdSeq += 1;
    const comment: Comment = { id: this.commentIdSeq, repoId: repo.id, issueNumber, body, seq: this.nextSeq() };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return repo.comments.get(issueNumber) ?? [];
  }

  // -- pull requests -----------------------------------------------------------

  /** Create a pull request; errors name what is missing or duplicated. */
  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): { pull: PullRequest } | { error: 'no-head' | 'no-base' | 'exists' } {
    const headSha = this.branchTip(repo, input.head);
    if (headSha === null) return { error: 'no-head' };
    const baseSha = this.branchTip(repo, input.base);
    if (baseSha === null) return { error: 'no-base' };
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return { error: 'exists' };
      }
    }
    this.pullIdSeq += 1;
    repo.pullSeq += 1;
    const pull: PullRequest = {
      id: this.pullIdSeq,
      repoId: repo.id,
      nodeId: gid('PullRequest', String(repo.id), String(repo.pullSeq)),
      number: repo.pullSeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headShaAtCreation: headSha,
      baseShaAtCreation: baseSha,
      seq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return { pull };
  }

  /** A pull request's current head and base tips (live refs, creation-time fallback). */
  pullTips(repo: Repo, pull: PullRequest): { headSha: string; baseSha: string } {
    return {
      headSha: this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation,
      baseSha: this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation,
    };
  }
}

// ---------------------------------------------------------------------------
// Graph walks (module functions over a Repo: the store and the git layer share them)

/** Every commit reachable from `tip`, tip first (parents after their child). */
export function walkCommits(store: Store, repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    out.push(oid);
    // Parents are pushed in reverse so the first parent is visited first.
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
  }
  return out;
}

/** Whether `ancestor` is reachable from `descendant` (or is the descendant). */
export function isAncestor(store: Store, repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/** The first common ancestor of two commits (the merge-base), or null. */
export function mergeBase(store: Store, repo: Repo, a: string, b: string): string | null {
  const fromA = new Set(walkCommits(store, repo, a, 100_000));
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (fromA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flat tree views

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree into path -> entry, recursively. */
export function flattenTree(store: Store, repo: Repo, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, dir: string): void => {
    const entries = store.getTree(repo, oid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Flatten a commit's tree (an empty map when the commit is null). */
export function flattenCommit(store: Store, repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
  if (commitOid === null) return new Map();
  const commit = store.getCommit(repo, commitOid);
  if (commit === null) return new Map();
  return flattenTree(store, repo, commit.tree);
}

/** Build a tree hierarchy from a flat path map, storing every tree object. */
export function buildTreeFromMap(store: Store, repo: Repo, flat: Map<string, FlatEntry>): string {
  // Group the paths by directory, deepest first, so each directory's tree is
  // built after the trees below it.
  interface DirNode {
    files: TreeEntry[];
    subdirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: [], subdirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.subdirs.get(part);
      if (next === undefined) {
        next = { files: [], subdirs: new Map() };
        node.subdirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1]!, oid: entry.oid });
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, sub] of node.subdirs) {
      entries.push({ mode: '40000', name, oid: build(sub) });
    }
    if (entries.length === 0) {
      // The empty tree: store it once and reuse its well-known id.
      if (!repo.objects.has(EMPTY_TREE_OID)) {
        repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
      }
      return EMPTY_TREE_OID;
    }
    const data = buildTree(entries);
    return store.putObject(repo, 'tree', data);
  };
  return build(root);
}

/**
 * Set or delete one path in a tree, storing the new trees. `blobOid` null
 * deletes the path. Returns the new root tree id, or null when the tree
 * became empty (the caller then uses EMPTY_TREE_OID).
 */
function updateTreePath(
  store: Store,
  repo: Repo,
  treeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
): string | null {
  const entries = treeOid === null ? [] : (store.getTree(repo, treeOid) ?? []);
  const [head, ...rest] = segments;
  const idx = entries.findIndex((entry) => entry.name === head);
  const next = [...entries];
  if (rest.length === 0) {
    // The file itself.
    if (blobOid === null) {
      if (idx >= 0) next.splice(idx, 1);
    } else {
      const entry: TreeEntry = { mode: '100644', name: head!, oid: blobOid };
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
    }
  } else {
    // A directory on the way down.
    const existing = idx >= 0 ? next[idx] : undefined;
    const subOid = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const updated = updateTreePath(store, repo, subOid, rest, blobOid);
    if (updated === null) {
      if (idx >= 0) next.splice(idx, 1);
    } else {
      const entry: TreeEntry = { mode: '40000', name: head!, oid: updated };
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
    }
  }
  if (next.length === 0) return null;
  return store.putObject(repo, 'tree', buildTree(next));
}

// ---------------------------------------------------------------------------
// Contents commits, reads and listings (the REST contents surface's engine)

/** A path split into segments; empty and dot segments are dropped. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part !== '' && part !== '.');
}

export type CommitFileResult =
  | { commitSha: string; blobSha: string; created: boolean }
  | { error: 'stale' | 'missing-sha' | 'not-a-file' };

/**
 * Commit one file on a branch (PUT /contents). A branch that does not exist
 * is created from the default branch's tip (or from nothing on an empty
 * repository). `sha` is the blob id the caller believes the file has: a
 * mismatch is a 409, and updating without one is a 422.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  opts: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
): CommitFileResult {
  const branch = opts.branch ?? repo.defaultBranch;
  const segments = splitPath(opts.path);
  if (segments.length === 0) return { error: 'not-a-file' };
  let tip = store.branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A new branch starts where the default branch is (or nowhere).
    tip = store.branchTip(repo, repo.defaultBranch);
  }
  const flat = flattenCommit(store, repo, tip);
  const current = flat.get(opts.path);
  if (current !== undefined) {
    if (opts.sha === undefined) return { error: 'missing-sha' };
    if (opts.sha.toLowerCase() !== current.oid.toLowerCase()) return { error: 'stale' };
  }
  const blobSha = store.putObject(repo, 'blob', opts.content);
  const baseTree = tip === null ? null : store.getCommit(repo, tip)?.tree ?? null;
  const newTree = updateTreePath(store, repo, baseTree, segments, blobSha) ?? EMPTY_TREE_OID;
  if (newTree === EMPTY_TREE_OID && !repo.objects.has(EMPTY_TREE_OID)) {
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  }
  const commitSha = store.writeCommit(repo, newTree, tip === null ? [] : [tip], opts.message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created: current === undefined };
}

export type DeleteFileResult = { commitSha: string } | { error: 'not-found' | 'stale' | 'no-branch' };

/** Delete one file on a branch (DELETE /contents). */
export function deleteFile(
  store: Store,
  repo: Repo,
  opts: { branch?: string; path: string; message: string; sha?: string },
): DeleteFileResult {
  const branch = opts.branch ?? repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (tip === null) return { error: 'no-branch' };
  const segments = splitPath(opts.path);
  if (segments.length === 0) return { error: 'not-found' };
  const flat = flattenCommit(store, repo, tip);
  const current = flat.get(opts.path);
  if (current === undefined) return { error: 'not-found' };
  if (opts.sha !== undefined && opts.sha.toLowerCase() !== current.oid.toLowerCase()) {
    return { error: 'stale' };
  }
  const baseTree = store.getCommit(repo, tip)?.tree ?? null;
  const newTree = updateTreePath(store, repo, baseTree, segments, null) ?? EMPTY_TREE_OID;
  if (newTree === EMPTY_TREE_OID && !repo.objects.has(EMPTY_TREE_OID)) {
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  }
  const commitSha = store.writeCommit(repo, newTree, [tip], opts.message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha };
}

export type ReadPathResult =
  | { kind: 'file'; sha: string; size: number; content: Buffer }
  | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> }
  | null;

/** Read a file or a directory listing at a ref (GET /contents). */
export function readPath(store: Store, repo: Repo, ref: string | undefined, path: string): ReadPathResult {
  const commitOid = store.resolveRef(repo, ref ?? repo.defaultBranch);
  if (commitOid === null) return null;
  const commit = store.getCommit(repo, commitOid);
  if (commit === null) return null;
  const segments = splitPath(path);
  // Walk the tree to the path's parent, then look the last segment up.
  let treeOid = commit.tree;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = store.getTree(repo, treeOid);
    if (entries === null) return null;
    const entry = entries.find((item) => item.name === segments[i]);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) {
        const sub = store.getTree(repo, entry.oid) ?? [];
        return {
          kind: 'dir',
          entries: sub.map((item) => ({
            type: (item.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
            name: item.name,
            path: `${path}/${item.name}`,
            sha: item.oid,
          })),
        };
      }
      treeOid = entry.oid;
      continue;
    }
    if (!last) return null;
    const blob = store.getObject(repo, entry.oid);
    if (blob === undefined || blob.type !== 'blob') return null;
    return { kind: 'file', sha: entry.oid, size: blob.data.length, content: blob.data };
  }
  // The repository root: list the root tree.
  const entries = store.getTree(repo, treeOid) ?? [];
  return {
    kind: 'dir',
    entries: entries.map((item) => ({
      type: (item.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: item.name,
      path: item.name,
      sha: item.oid,
    })),
  };
}

/** A commit list entry: the sha and the message REST and GraphQL read. */
export interface CommitListEntry {
  sha: string;
  message: string;
  tree: string;
  parents: string[];
}

/** The commits reachable from a ref, newest first. */
export function listCommits(store: Store, repo: Repo, ref: string | undefined): CommitListEntry[] | null {
  const tip = store.resolveRef(repo, ref ?? repo.defaultBranch);
  if (tip === null) return null;
  const out: CommitListEntry[] = [];
  for (const oid of walkCommits(store, repo, tip)) {
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    out.push({ sha: oid, message: commit.message, tree: commit.tree, parents: commit.parents });
  }
  return out;
}

/** Every branch with its tip, default branch first, the rest by name. */
export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => {
    if (a.name === repo.defaultBranch) return -1;
    if (b.name === repo.defaultBranch) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Pull-request diffs and merges

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count a blob's lines (an empty blob has none). */
function lineCount(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * A line-multiset diff: lines gained and lost between two blobs. When the
 * blobs differ but the multisets agree (a reorder), the change still counts
 * as one addition and one deletion, so a changed file always reports at
 * least one addition.
 */
function diffLines(oldContent: Buffer, newContent: Buffer): { additions: number; deletions: number } {
  const count = (content: Buffer): Map<string, number> => {
    const map = new Map<string, number>();
    if (content.length === 0) return map;
    for (const line of content.toString('utf8').split('\n')) {
      map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const before = count(oldContent);
  const after = count(newContent);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of after) additions += Math.max(0, n - (before.get(line) ?? 0));
  for (const [line, n] of before) deletions += Math.max(0, n - (after.get(line) ?? 0));
  if (additions === 0 && deletions === 0 && !oldContent.equals(newContent)) {
    additions = 1;
    deletions = 1;
  }
  if (additions === 0) additions = 1;
  return { additions, deletions };
}

/** The changed files of a pull request: merge-base tree against head tree. */
export function pullRequestFiles(store: Store, repo: Repo, pull: PullRequest): PullFile[] {
  const { headSha, baseSha } = store.pullTips(repo, pull);
  const base = mergeBase(store, repo, headSha, baseSha);
  const before = flattenCommit(store, repo, base);
  const after = flattenCommit(store, repo, headSha);
  const out: PullFile[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const blob = store.getObject(repo, newEntry.oid);
      const additions = Math.max(1, blob === undefined ? 1 : lineCount(blob.data));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const blob = store.getObject(repo, oldEntry.oid);
      const deletions = Math.max(1, blob === undefined ? 1 : lineCount(blob.data));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      const oldBlob = store.getObject(repo, oldEntry.oid)?.data ?? Buffer.alloc(0);
      const newBlob = store.getObject(repo, newEntry.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = diffLines(oldBlob, newBlob);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/**
 * The three-way merge of a pull request: base (merge-base) against ours (the
 * base tip) and theirs (the head tip), per file. Returns the merged flat
 * tree, or the conflicting paths.
 */
export function threeWayMerge(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { merged: Map<string, FlatEntry> } | { conflict: string[] } {
  const { headSha, baseSha } = store.pullTips(repo, pull);
  const base = mergeBase(store, repo, headSha, baseSha);
  const baseTree = flattenCommit(store, repo, base);
  const ours = flattenCommit(store, repo, baseSha);
  const theirs = flattenCommit(store, repo, headSha);
  const merged = new Map<string, FlatEntry>();
  const conflict: string[] = [];
  const paths = new Set([...baseTree.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    if (o === t) {
      if (o !== null) merged.set(path, ours.get(path) ?? theirs.get(path)!);
    } else if (o === b) {
      if (t !== null) merged.set(path, theirs.get(path)!);
    } else if (t === b) {
      if (o !== null) merged.set(path, ours.get(path)!);
    } else {
      conflict.push(path);
    }
  }
  if (conflict.length > 0) return { conflict };
  return { merged };
}

/** Whether a pull request would merge cleanly (GraphQL `mergeable`). */
export function pullRequestMergeable(store: Store, repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.state !== 'open') return 'MERGEABLE';
  return 'conflict' in threeWayMerge(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

export type MergeResult = { sha: string } | { error: 'not-found' | 'already' | 'conflict' };

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is
 * the three-way merge result and whose parent is the base tip. The pull
 * request closes as merged.
 */
export function mergePullRequest(store: Store, repo: Repo, number: number): MergeResult {
  const pull = repo.pullByNumber.get(number);
  if (pull === undefined) return { error: 'not-found' };
  if (pull.state !== 'open' || pull.merged) return { error: 'already' };
  const merged = threeWayMerge(store, repo, pull);
  if ('conflict' in merged) return { error: 'conflict' };
  const { baseSha } = store.pullTips(repo, pull);
  const tree = buildTreeFromMap(store, repo, merged.merged);
  const sha = store.writeCommit(repo, tree, [baseSha], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoTime(store.nextSeq());
  pull.mergeCommitSha = sha;
  return { sha };
}
