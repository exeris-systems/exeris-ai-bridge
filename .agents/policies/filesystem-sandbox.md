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

Never accept an absolute path from the agent and read it. Always resolve relative to a pinned root,
and verify the **resolved** path stays inside that root.

This applies to paths *we* generate too. The bundle manifest is ours, but it is still a file on disk
that a later step could rewrite, so its entry paths are sandbox-checked like any other.

The review procedure for a handler that touches the filesystem is the
`exeris-ai-bridge-path-sandbox-review` skill.
