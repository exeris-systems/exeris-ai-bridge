---
description: Verify that filesystem reads in `docs:*` (and any future filesystem tool) resolve under a pinned root and reject paths that escape it.
argument-hint: PR diff or `src/tools/docs/**` change to audit
---

Audit this change for path-sandbox discipline.

Sandbox rules:
- Filesystem reads in `docs:*` (and any future filesystem-bound family) MUST resolve under a configured root (`EXERIS_DOCS_ROOT` default; `../exeris-docs` neighbour layout).
- Never accept an absolute path from the agent and read it.
- Always resolve relative to the pinned root.
- After resolving, verify the canonical resolved path is still inside the root (using `path.resolve` + `startsWith` against the canonical root — handle `..`, symlinks, encoded traversal).
- Reject reads that escape — return a structured error, do not throw.

Change:
$ARGUMENTS

Please review:
1. Does any handler accept a path / filename / URI from the agent?
2. Is the path resolved against a pinned root?
3. Is the resolved path verified to stay inside the root (after canonical resolution)?
4. Are symlinks / `..` / URL-encoded traversal handled?
5. On rejection, does the handler return a structured error (not throw)?
6. Minimal correction if the sandbox is at risk.

Path-traversal hardening is from day 1 per ROADMAP 0.2.0 — this is not "later".
