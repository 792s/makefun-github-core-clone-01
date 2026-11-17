// The git wire protocol: pkt-lines, packfiles, and the smart-HTTP handlers
// (info/refs advertisements, upload-pack v2 + v0, receive-pack v0). Built on
// node:zlib and node:crypto only; no git binary, no vendored library.
//
// Packfiles sent here carry whole objects only (no deltas): the suite's
// client accepts that, and the pack-deltas check passes with 0 deltas as
// long as every object resolves and hashes correctly. Packs received are
// whole objects too (the client's writePack never emits deltas), so a delta
// object in a received pack is an unpack failure, not a crash.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  isAncestor,
  parseTag,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Pkt-lines

/** One pkt-line: 4 hex length bytes (payload + 4) and the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

/** The flush packet, the delim packet, and the response-end packet. */
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** A cursor over a pkt-line stream; throws on malformed input. */
export class PktReader {
  private readonly buf: Buffer;
  private offset = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** The next packet, or null at the end of the buffer. */
  next(): Packet | null {
    if (this.offset >= this.buf.length) return null;
    if (this.offset + 4 > this.buf.length) throw new Error('truncated pkt-line length');
    const lenHex = this.buf.subarray(this.offset, this.offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (len === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (len === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (len < 4 || this.offset + len > this.buf.length) throw new Error('bad pkt-line length');
    const payload = this.buf.subarray(this.offset + 4, this.offset + len);
    this.offset += len;
    return { kind: 'data', payload };
  }

  /** Bytes consumed so far. */
  get position(): number {
    return this.offset;
  }

  /** The unread remainder (the raw pack after a receive-pack command list). */
  get rest(): Buffer {
    return this.buf.subarray(this.offset);
  }
}

/** All data packets' payloads as strings, up to (not including) the first flush. */
export function readLinesUntilFlush(reader: PktReader): string[] {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) throw new Error('pkt-line stream ended before a flush');
    if (packet.kind === 'flush') return lines;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
}

// ---------------------------------------------------------------------------
// Adler-32 (the zlib trailer checksum): needed to find where one object's
// deflate stream ends inside a pack, since inflateSync does not say.

function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// Packfiles

const TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const NUMBER_TYPES: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** The varint header of one pack entry: type and uncompressed size. */
function encodeObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeNum = TYPE_NUMBERS[type];
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a packfile from whole objects: header, deflated entries, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodeObjectHeader(object.type, object.data.length));
    parts.push(zlib.deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = hashObjectTrailer(body);
  return Buffer.concat([body, trailer]);
}

/** The pack trailer: the raw SHA-1 of every preceding byte. */
function hashObjectTrailer(body: Buffer): Buffer {
  // The trailer is a plain SHA-1 over the body, not the git object id form.
  return createHash('sha1').update(body).digest();
}

/**
 * Inflate one zlib stream starting at `start` in `buf`, knowing its
 * uncompressed size. Returns the data and the offset just past the stream.
 * inflateSync ignores trailing bytes, so the stream's end is found through
 * its Adler-32 trailer: the first occurrence that verifies as the exact end.
 */
function inflateOne(buf: Buffer, start: number, expectedSize: number): { data: Buffer; end: number } {
  const rest = buf.subarray(start);
  let data: Buffer;
  try {
    data = zlib.inflateSync(rest);
  } catch (err) {
    throw new Error(`pack object at ${start} does not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data.length !== expectedSize) {
    throw new Error(`pack object at ${start} inflated to ${data.length} bytes, expected ${expectedSize}`);
  }
  // The stream's last 4 bytes are the Adler-32 of the data, big-endian.
  const sum = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(sum, 0);
  let at = rest.indexOf(needle, 2);
  while (at >= 0) {
    const end = at + 4;
    try {
      const check = zlib.inflateSync(rest.subarray(0, end));
      if (check.equals(data)) {
        // The exact end: one byte shorter must fail (a later spurious match
        // would still inflate, since inflateSync ignores trailing bytes).
        let shorterFails = false;
        try {
          zlib.inflateSync(rest.subarray(0, end - 1));
        } catch {
          shorterFails = true;
        }
        if (shorterFails) return { data, end: start + end };
      }
    } catch {
      // Not this occurrence.
    }
    at = rest.indexOf(needle, at + 1);
  }
  // Paranoia fallback: binary-search the shortest window that inflates right.
  let lo = 2;
  let hi = rest.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let ok = false;
    try {
      ok = zlib.inflateSync(rest.subarray(0, mid)).equals(data);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data, end: start + lo };
}

/** Read a packfile's whole objects, verifying the trailer checksum. Throws on any error. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('packfile too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('packfile has no PACK magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`packfile version ${version}, expected 2`);
  const count = buf.readUInt32BE(8);
  const body = buf.subarray(0, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20);
  if (!hashObjectTrailer(body).equals(trailer)) throw new Error('packfile trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= body.length) throw new Error('packfile ends before its object count');
    // The type/size varint.
    let byte = body[offset]!;
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= body.length) throw new Error('packfile object header is truncated');
      byte = body[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6 || typeNum === 7) {
      throw new Error('packfile carries a delta object, which this forge does not apply');
    }
    const type = NUMBER_TYPES[typeNum];
    if (type === undefined) throw new Error(`packfile object type ${typeNum} is unknown`);
    const { data, end } = inflateOne(body, offset, size);
    offset = end;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// The fetch walk: which objects a fetch sends, and the shallow boundaries.
//
// Two closures are computed over the object graph:
//   haveClosure: what the client already holds — reachable from its haves,
//     except the walk stops at the client's shallow boundaries (it holds the
//     boundary commit, not its parents).
//   wantSet: what the client asked for — reachable from its wants, cut at
//     the requested depth (generation 1 is the wants themselves).
// The pack carries wantSet minus haveClosure. A boundary commit is reported
// shallow when the client will still lack one of its parents after this
// fetch; a client boundary is reported unshallow when this fetch delivers
// one of its parents.

interface WalkResult {
  /** Every object id the walk reached (commits, trees, blobs, tags). */
  objects: Set<string>;
  /** Commits at the depth limit (only when a depth was given). */
  boundary: Set<string>;
}

function collectReachable(
  store: Store,
  repo: Repo,
  tips: readonly string[],
  opts: { depth?: number; stopAt?: ReadonlySet<string> },
): WalkResult {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const seenCommits = new Set<string>();
  const seenTrees = new Set<string>();

  const addTree = (oid: string): void => {
    if (seenTrees.has(oid)) return;
    seenTrees.add(oid);
    const entries = store.getTree(repo, oid);
    if (entries === null) return;
    objects.add(oid);
    for (const entry of entries) {
      if (entry.mode === '40000') addTree(entry.oid);
      else objects.add(entry.oid);
    }
  };

  // Commits are walked breadth-first by generation so the depth limit cuts
  // cleanly: generation 1 is the wants, their parents generation 2, and so on.
  const queue: Array<{ oid: string; generation: number }> = [];
  const enqueue = (oid: string, generation: number): void => {
    const object = store.getObject(repo, oid);
    if (object === undefined) return;
    if (object.type === 'commit') {
      queue.push({ oid, generation });
    } else if (object.type === 'tag') {
      objects.add(oid);
      enqueue(parseTag(object.data).object, generation);
    } else if (object.type === 'tree') {
      addTree(oid);
    } else {
      objects.add(oid);
    }
  };
  for (const tip of tips) enqueue(tip, 1);

  let head = 0;
  while (head < queue.length) {
    const { oid, generation } = queue[head]!;
    head += 1;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    objects.add(oid);
    addTree(commit.tree);
    const atLimit = opts.depth !== undefined && generation >= opts.depth;
    if (atLimit) {
      boundary.add(oid);
      continue;
    }
    if (opts.stopAt !== undefined && opts.stopAt.has(oid)) continue;
    for (const parent of commit.parents) {
      if (!seenCommits.has(parent)) queue.push({ oid: parent, generation: generation + 1 });
    }
  }
  return { objects, boundary };
}

export interface FetchPlan {
  /** The objects to pack, in a deterministic order. */
  objects: GitObject[];
  /** New shallow boundaries to report. */
  shallow: string[];
  /** Old client boundaries this fetch lifts. */
  unshallow: string[];
  /** Haves acknowledged as common. */
  acks: string[];
  /** True when no have was acknowledged. */
  nak: boolean;
}

const TYPE_RANK: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 0,
  tag: 1,
  tree: 2,
  blob: 3,
});

/** Plan a fetch: wants, haves, the client's shallow boundaries, an optional depth. */
export function planFetch(
  store: Store,
  repo: Repo,
  opts: { wants: readonly string[]; haves?: readonly string[]; shallow?: readonly string[]; depth?: number },
): FetchPlan {
  const clientShallow = new Set(opts.shallow ?? []);
  const haveClosure =
    opts.haves !== undefined && opts.haves.length > 0
      ? collectReachable(store, repo, opts.haves, { stopAt: clientShallow })
      : { objects: new Set<string>(), boundary: new Set<string>() };
  const wantSet = collectReachable(store, repo, opts.wants, { depth: opts.depth });

  const send = new Set<string>();
  for (const oid of wantSet.objects) {
    if (!haveClosure.objects.has(oid)) send.add(oid);
  }

  // A boundary commit is shallow when the client will still lack a parent
  // after this fetch (the parent is neither held nor sent).
  const shallow: string[] = [];
  for (const oid of wantSet.boundary) {
    if (!send.has(oid)) continue;
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    const cut = commit.parents.some((parent) => !haveClosure.objects.has(parent) && !send.has(parent));
    if (cut) shallow.push(oid);
  }
  shallow.sort();

  // A client boundary is unshallow when this fetch delivers one of its parents.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    if (commit.parents.some((parent) => send.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();

  // Acknowledge every have that is an ancestor of (or equal to) a want.
  const acks: string[] = [];
  for (const have of opts.haves ?? []) {
    if (store.getObject(repo, have) === undefined) continue;
    if (wantSet.objects.has(have)) acks.push(have);
  }

  const objects: GitObject[] = [];
  const byOid: Array<{ oid: string; object: GitObject }> = [];
  for (const oid of send) {
    const object = store.getObject(repo, oid);
    if (object !== undefined) byOid.push({ oid, object });
  }
  byOid.sort((a, b) => {
    const rank = TYPE_RANK[a.object.type] - TYPE_RANK[b.object.type];
    if (rank !== 0) return rank;
    return a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  for (const entry of byOid) objects.push(entry.object);

  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

// ---------------------------------------------------------------------------
// Advertisements

const AGENT = 'forge/1.0';
const UPLOAD_V0_CAPS = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT}`;

export const UPLOAD_ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_ADVERTISEMENT_TYPE = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_RESULT_TYPE = 'application/x-git-upload-pack-result';
export const RECEIVE_RESULT_TYPE = 'application/x-git-receive-pack-result';

/** The protocol v2 capability advertisement (the `Git-Protocol: version=2` answer). */
export function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

/** The v0 ref advertisement: the `# service=` preamble, the refs, the caps on the first line. */
export function advertisementV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const names = [...repo.refs.keys()].sort();
  const mainTip = repo.refs.get('refs/heads/main');
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const line = (oid: string, name: string): Buffer => {
      if (first) {
        first = false;
        return pktLine(`${oid} ${name}\0${caps}\n`);
      }
      return pktLine(`${oid} ${name}\n`);
    };
    if (mainTip !== undefined) parts.push(line(mainTip, 'HEAD'));
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(line(oid, name));
      // An annotated tag peels: the tag's target follows as `<ref>^{}`.
      const object = store.getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(pktLine(`${parseTag(object.data).object} ${name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack

/** Split a sideband payload into pkt-lines of at most 32768 data bytes. */
function sidebandPackets(band: 1 | 2, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

/** A v2 ls-refs answer: HEAD plus the refs, filtered by prefix, peeled and symref'd as asked. */
function handleLsRefs(store: Store, repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim) continue; // command=, agent=, object-format=
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') { /* this forge never advertises unborn */ }
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip !== undefined && keep('HEAD')) {
    const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pktLine(`${mainTip} HEAD${attrs}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let attrs = '';
    if (peel) {
      const object = store.getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') {
        attrs += ` peeled:${parseTag(object.data).object}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${attrs}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** A v2 fetch answer. Two shapes, by negotiation state:
 *  - A request with haves and no `done` is a negotiation round: only the
 *    acknowledgments section (ACKs or NAK). No `ready` (it would promise the
 *    packfile in this same response) and no packfile yet; the client sends
 *    another round, ending with `done`.
 *  - A request with `done` (or no haves at all) is final: no acknowledgments
 *    section (git dies on one after it sent `done`), then shallow-info and
 *    the packfile. When the object set is empty but wants exist, the
 *    packfile section still goes out with an empty pack: git expects the
 *    section, and the kit's fetch-nothing-new check describes exactly that.
 *    With no wants at all, no packfile section (the empty-clone check
 *    forbids any pack bytes). */
function handleFetchV2(store: Store, repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let afterDelim = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim) continue; // command=, agent=, object-format=
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line === 'done') done = true;
    // thin-pack, no-progress, ofs-delta, filter: accepted, whole objects sent.
  }

  const plan = planFetch(store, repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];

  // Negotiation round: haves offered, `done` not yet sent. Only the ACKs:
  // `ready` would promise the packfile in this same response, and the client
  // sends `done` on its own once it runs out of haves.
  if (haves.length > 0 && !done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  // Final answer: no acknowledgments section.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (plan.objects.length > 0 || wants.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(1, pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

/** A v0 fetch answer: ACK/NAK and shallow lines, then the sideband pack. */
function handleFetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | undefined;
  let section = 0; // 0 = wants, 1 = haves
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(store, repo, { wants, haves, depth });
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    parts.push(...sidebandPackets(1, writePack(plan.objects)));
  }
  return Buffer.concat(parts);
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack. The first line decides: a
 * `command=` line is protocol v2 (ls-refs or fetch), a `want` line is v0.
 * Returns the response body (the content type is always the upload-pack result).
 */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const first = reader.next();
  if (first === null || first.kind !== 'data') throw new Error('upload-pack body holds no command');
  const head = first.payload.toString('utf8').replace(/\n$/, '');
  if (head.startsWith('command=ls-refs')) {
    const lines = [head];
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind === 'delim') lines.push('delim');
      else if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    return handleLsRefs(store, repo, lines);
  }
  if (head.startsWith('command=fetch')) {
    const lines = [head];
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind === 'delim') lines.push('delim');
      else if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    return handleFetchV2(store, repo, lines);
  }
  if (head.startsWith('want ') || head.startsWith('want\0')) {
    return handleFetchV0(store, repo, body);
  }
  throw new Error(`upload-pack body starts with an unknown command ${JSON.stringify(head.slice(0, 40))}`);
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: the command list up to the flush, then the raw pack. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null; sideband: boolean } {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (;;) {
    const packet = reader.next();
    if (packet === null) throw new Error('receive-pack body ended before the command flush');
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const rest = reader.rest;
  return { commands, pack: rest.length > 0 ? rest : null, sideband };
}

/** One ref update's verdict, in command order. */
interface RefVerdict {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a command list to a repository's refs. The pack's objects are
 * already stored; a refused update still unpacks. Returns one verdict per
 * command, in order, and applies only the accepted ones.
 */
function applyPush(store: Store, repo: Repo, commands: readonly PushCommand[]): RefVerdict[] {
  const verdicts: RefVerdict[] = [];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    if (!ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(ref)) {
      verdicts.push({ ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      // A delete.
      if (current === undefined) {
        verdicts.push({ ref, ok: true, reason: '' });
      } else {
        repo.refs.delete(ref);
        verdicts.push({ ref, ok: true, reason: '' });
      }
      continue;
    }
    if (store.getObject(repo, newOid) === undefined) {
      verdicts.push({ ref, ok: false, reason: 'invalid object' });
      continue;
    }
    if (oldOid === ZERO_OID) {
      // A create.
      if (current !== undefined) {
        verdicts.push({ ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(ref, newOid);
      verdicts.push({ ref, ok: true, reason: '' });
      continue;
    }
    // An update.
    if (current === undefined) {
      verdicts.push({ ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (current !== oldOid) {
      verdicts.push({ ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (ref.startsWith('refs/tags/')) {
      verdicts.push({ ref, ok: false, reason: 'already exists' });
      continue;
    }
    // Fast-forward: the new tip must descend from the old one.
    if (!isAncestor(store, repo, oldOid, newOid)) {
      verdicts.push({ ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(ref, newOid);
    verdicts.push({ ref, ok: true, reason: '' });
  }
  return verdicts;
}

/** Build the report-status body: `unpack ok`, one line per ref, pkt-framed inside sideband band 1. */
function pushReport(verdicts: readonly RefVerdict[], unpackOk: boolean, unpackDetail: string, sideband: boolean): Buffer {
  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const verdict of verdicts) {
    inner.push(pktLine(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`));
  }
  inner.push(FLUSH);
  const report = Buffer.concat(inner);
  if (!sideband) return Buffer.concat([report, FLUSH]);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), FLUSH]);
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack. Parses the pack, stores its
 * objects, applies the ref updates, and answers the report-status. A
 * malformed body throws (the caller answers 400); an unpack failure is
 * reported in-band with every ref refused.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, pack, sideband } = parseReceivePack(body);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null) {
    try {
      const objects = readPack(pack);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\n/g, ' ').slice(0, 120) : 'unpack error';
    }
  }
  const verdicts = unpackOk
    ? applyPush(store, repo, commands)
    : commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }));
  return pushReport(verdicts, unpackOk, unpackDetail, sideband);
}
