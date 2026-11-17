# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/792s/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/792s/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge in dependency-free TypeScript (Node 22 standard library
only), built for the make.fun `github-core-clone-01` bounty. One process serves
four surfaces from a single in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs, fetch with shallow/deepen) and receive-pack v0 with report-status.
  The packfile and pkt-line codecs are implemented from scratch on
  `node:zlib` and `node:crypto`; no git binary, no vendored library.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update/delete with blob-sha conflict detection), labels, issues,
  comments and pull requests with squash merge and file-level three-way
  conflict detection.
- **GraphQL v4** at `/api/graphql` — a small hand-written parser and executor
  for the documents `gh` and github-mcp-server send, including `__type`
  introspection, Relay global ids, `node(id:)`, cursor pagination and
  operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP, revision
  `2026-07-28` (`server/discover`) with the `initialize` handshake as a
  fallback, and six tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Layout

- `main.ts` — the entry lifecycle: bind an ephemeral port, register it with
  the env, poll `/done`, exit 0.
- `app.ts` — the HTTP server, routing, auth and the shared response helpers.
- `store.ts` — the in-memory store and all domain logic: git objects, refs,
  issues, pull requests, diffs and merges.
- `git.ts` — the git wire protocol: pkt-lines, packfiles, advertisements,
  ls-refs, fetch and receive-pack.
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — the GraphQL parser, schema and executor.
- `mcp.ts` — the MCP JSON-RPC handlers.

## Running

```sh
node main.ts
```

The process needs `MAKEFUN_ENV_URL` (the env origin) and `MAKEFUN_SHOP_TOKEN`
(the bearer token every API call presents). Without `MAKEFUN_ENV_URL` it exits
1; without a token it serves unauthenticated, which is only useful for local
smoke tests.

## Notes

- The forge keeps everything in memory; a restart is a fresh, empty forge.
- The viewer login is learned from the first request that names an existing
  repository's owner: the token carries no login, so the forge takes it from
  the paths the suite itself uses. A repository under any other owner is a
  404, never a 403.
- Commit timestamps are a deterministic counter from a fixed epoch, so two
  runs of the same request sequence produce the same object ids.

<sub>Entered on [make.fun](https://make.fun/?ref=d5a50dzy&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
