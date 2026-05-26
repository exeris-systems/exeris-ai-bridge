---
name: exeris-ai-bridge-path-sandbox-review
description: Path-sandbox review for filesystem-bound tool handlers in exeris-ai-bridge. Use on every PR touching `src/tools/docs/**` or any new filesystem-bound family.
---

# Exeris AI Bridge Path-Sandbox Review

## Purpose
Enforce: filesystem reads in `docs:*` (and any future filesystem-bound family) resolve under a pinned root (`EXERIS_DOCS_ROOT` / `../exeris-docs` default) and reject paths that escape it.

Agent-supplied strings reach handlers. Sandbox is from day 1 per ROADMAP 0.2.0.

## When to Use
- Any PR adding or changing a filesystem-bound handler.
- Any PR introducing a new filesystem-bound family.
- Any PR touching the path-resolution helper / root configuration.

## Required Inputs
- PR diff scoped to `src/tools/docs/**` (or new family).
- Path-resolution helper code.
- Root configuration (env var, default).

## Review Procedure
1. **Input audit** — does the handler accept a `path` / `filename` / `uri` / `name` from the agent?
2. **Absolute-path audit** — reject reads of absolute paths supplied by the agent. Always resolve relative to a pinned root.
3. **Resolution audit** — the path MUST be resolved with `path.resolve(root, input)` (or equivalent) and the result MUST be canonicalised.
4. **Containment check** — the canonical resolved path MUST be verified to start with the canonical root (`resolved.startsWith(rootCanonical + path.sep)` or equivalent). String prefix check on unresolved paths is insufficient.
5. **Symlink / traversal audit** — handle `..` segments, URL-encoded traversal (`%2e%2e`), symlinks that point outside the root. Reject if canonicalisation escapes.
6. **Error shape** — rejection returns a structured error response (MCP `isError: true`); never throws / crashes the handler.
7. **Test coverage** — require at least one traversal-attempt test per filesystem-bound handler.
8. **Decision and report** — `APPROVE` / `CONDITIONAL` / `REJECT`.

## Decision Logic
- **APPROVE**: Pinned root used; canonical resolution; containment verified; symlink/traversal handled; rejection returns structured error; traversal test present.
- **CONDITIONAL**: Sound resolution but missing traversal test — propose the test as minimum addition.
- **REJECT**: Absolute-path read accepted; missing containment check; throws on rejection; missing canonicalisation.

## Completion Criteria
- Input, resolution, containment, traversal handling, error shape audited.
- Test coverage confirmed or proposed.
- Verdict and remediation recorded.

## Review Output Template
1. **Scope analysed** (filesystem-bound handlers)
2. **Input audit** (agent-supplied path surfaces)
3. **Resolution audit** (root + canonicalisation)
4. **Containment audit** (canonical prefix check)
5. **Traversal / symlink audit**
6. **Error shape** (structured / throws)
7. **Test coverage**
8. **Verdict** (`APPROVE` / `CONDITIONAL` / `REJECT`)
9. **Required actions** (precise and minimal)

## Non-Negotiable Rules
- Never accept an absolute path from the agent.
- Never rely on string prefix check before canonicalisation.
- Never let a sandbox failure crash the handler.
