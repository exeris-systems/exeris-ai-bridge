# `.claude/` — Claude Code workspace for `exeris-ai-bridge`

This directory is loaded automatically when a Claude Code session opens inside
`~/exeris-systems/exeris-ai-bridge/`. It exists alongside the repo-root [`CLAUDE.md`](../CLAUDE.md)
and works as the operating context for AI assistants on the MCP server.

## Layout

- `agents/` — sub-agents Claude can launch via the `Agent` tool (or the user can invoke directly):
  - `exeris-ai-bridge-router.md` — entrypoint triage; classifies work and routes to the right specialist
  - `exeris-ai-bridge-architect.md` — Wall by construction, no model API, no mutation, not-a-capability, tool family scope
  - `exeris-ai-bridge-implementer.md` — concrete TS code in `src/server.ts`, `src/tools/{docs,lsp,kernel}/`
  - `exeris-ai-bridge-tool-family-discipline.md` — owns the `docs:*` / `lsp:*` / `kernel:*` namespacing and family scope
  - `exeris-ai-bridge-docs-adr.md` — ADR-025 amendment / cross-repo link stubs / ROADMAP milestone bookkeeping
- `commands/` — slash commands invocable as `/<command-name>`:
  - `wall-process-boundary-check.md`, `read-only-tool-check.md`, `path-sandbox-check.md`, `tool-family-purity.md`
- `skills/` — invocable skills (`/<skill-name>`):
  - `exeris-ai-bridge-task-classifier`, `exeris-ai-bridge-routing-planner`
  - `exeris-ai-bridge-wall-process-boundary-review`, `exeris-ai-bridge-read-only-tool-review`
  - `exeris-ai-bridge-path-sandbox-review`, `exeris-ai-bridge-tool-family-purity-review`

## Doctrine — single source

Project doctrine is **not** duplicated under `.claude/` to avoid drift:

- **`/CLAUDE.md`** (repo root) — auto-loaded operating context (load-bearing facts, hard constraints, strong defaults, scoped bans, tool family scope, cross-repo ADR consult list).
- **`docs/adr/ADR-025-ai-agent-bridge.md`** — founding decision; treat amendments like constitutional amendments.
- **`README.md`** — agent-facing entry, architecture diagram (separate process / separate language from kernel), wiring snippet.
- **`ROADMAP.md`** — milestone scope (0.1.0 scaffold shipped → 1.0.0 GA = stable MCP tool surface).

When skills/agents need policy context, they reference these — they do not restate them.
