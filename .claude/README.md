# `.claude/` — generated adapters and provider configuration

This directory is **not** where project rules are authored. Per `agents-md-schema.md` rules 2 and 7
(in `exeris-systems/exeris-docs`, under `standards/`), the canonical semantic source is
[`.agents/`](../.agents) and this directory adapts it for Claude Code. The portable entry point is
[`AGENTS.md`](../AGENTS.md).

- `agents/` — **generated** from `.agents/agents/<name>/AGENT.md`. The canonical frontmatter is
  vendor-neutral (`capabilities`, `model` tiers); the Claude tool list and model id here are
  produced by the mapping in `exeris-systems/exeris-agents` → `tools/adapters/claude.yaml`.
- `skills/` — one symlink per skill into `.agents/skills/`, plus a **generated** directory per
  workflow (a workflow is a user-invoked skill on this runtime, with `disable-model-invocation`).
  Nothing here is a copy of a skill. A checkout without symlink support renders with
  `agents_render.py --skills-copy`, which the manifest records as a degradation.
- `settings.local.json` — provider-owned local configuration, git-ignored. Never semantic content.

Regenerate with `python3 <path-to>/exeris-agents/tools/agents_render.py --root .`, and verify with
`--check`. A change made here by hand is lost the next time the adapters are regenerated.
