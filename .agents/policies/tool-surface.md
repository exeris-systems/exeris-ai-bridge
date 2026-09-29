---
title: "Policy — the MCP tool surface"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-29
---

# Policy — the MCP tool surface

How a tool is named, where it is registered, and what it takes to add one. Which families exist and
what each reads is in [`tool-families`](../references/tool-families.md); the authorisation for each
is [ADR-025](../../docs/adr/ADR-025-ai-agent-bridge.md) and its amendments.

## Naming

**Tool names are `family-tool` on the wire; `family:*` stays the prose name for a family in docs.**
MCP clients do not reliably resolve a `:` inside a tool name, so the registered name is
`docs-get_adr`, not `docs:get_adr`.

The family prefix is load-bearing by convention rather than by construction: `guard()` is handed its
`ToolFamily` explicitly, and it is the tests that split the registered name on the first `-` and
assert the halves agree with the family the handler was bound to. So a tool name is exactly one
family, one hyphen, then `snake_case` — a second hyphen would silently split into the wrong family
key. A test holds the whole surface to `^[a-z]+-[a-z_]+$`; it is not weakened to accommodate a name
that wants a second hyphen.

The `family:*` spelling is for *documentation* — `AGENTS.md`, `README.md`, `ROADMAP.md`, ADR-025,
the files under `.agents/` — where it names a family as a concept. Strings the **agent** reads at
runtime use the wire form instead (`unavailableResult` says `docs-*`), because the agent's only
handle on a family is the tool names it can actually see in `tools/list`.

## Registration

Tool definitions live next to their handlers. Each `src/tools/<family>/index.ts` registers its own
tools and exports a `register<Family>Tools()` function. The server entry composes the registries —
it does not know individual tool names.

## Scope and growth

- Keep each family's scope tight; if a tool would cross families, refactor first.
- **A new family requires an ADR-025 amendment** (or a successor ADR) before any code. A `sku:*`
  family is not invented unilaterally.
- Adding a tool to an existing family is milestone work, scheduled in `ROADMAP.md`, not a
  free-for-all.
- **`bridge:*` is frozen at two tools** (ADR-025 2026-08-26 addendum). It is also the one family
  that is never environment-gated, which is why it is excluded from the `ToolFamily` union the
  availability guard ranges over — "gate `bridge:*`" stays inexpressible rather than merely
  discouraged.
- `kernel:*` is **cap-blind** (ADR-024 2026-06-17 amendment): there is no `kernel-list_capabilities`,
  and any composition surface sources from build-time artefacts under its own family.
- `build:*` **reads what the pipeline emitted; it never predicts what it would emit.** Only 2 of the
  13 generators state their gate in `supports()`; the rest decide by a null sentinel inside
  `generate(...)`, so a prediction here would be a second implementation of eleven internal guards.
  `caps:*` likewise reads manifests and never re-resolves the `@Requires`→`@Provides` DAG.
