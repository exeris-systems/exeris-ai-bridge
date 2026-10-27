---
title: "Policy — filesystem reads are sandboxed to pinned roots"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-30
---

# Policy — filesystem reads are sandboxed to pinned roots

Every filesystem-bound handler reads under a root the server pinned, never under a root the agent
named:

- `docs:*` reads the configured `exeris-docs` checkout (`../exeris-docs/` beside this repository in
  an ecosystem checkout), or, when none resolves, the registry snapshot under
  `<packageRoot>/data/docs/`, whose digests are verified at boot.
- The bundled reference corpus reads `<packageRoot>/data/`.
- `build:*` and `caps:*` read the pinned `projectRoot` and nothing above it.
- `lsp:*` pins the LSP workspace root, which defaults to the bridge's working directory unless
  `EXERIS_LSP_WORKSPACE` is set. The bridge may **watch** that root, read-only, to tell the language
  server about writes by other processes: one watcher per root, confined to it (events are resolved
  and dropped when they leave it, symlinked directories are never followed), with no watch under
  `.git`, `node_modules`, `dist`, `target` (except `target/generated-sources`) or `build` (except
  `build/generated`), at most 10 000 watched directories, and no watch at all when the root is a
  filesystem root or the home directory. Past those bounds the watch degrades to an invalidation
  before each request.

Never accept an absolute path from the agent and read it. Always resolve relative to a pinned root,
and verify the **resolved** path stays inside that root.

This applies to paths *we* generate too. The bundle manifest is ours, but it is still a file on disk
that a later step could rewrite, so its entry paths are sandbox-checked like any other.

The review procedure for a handler that touches the filesystem is the
`exeris-ai-bridge-path-sandbox-review` skill.
