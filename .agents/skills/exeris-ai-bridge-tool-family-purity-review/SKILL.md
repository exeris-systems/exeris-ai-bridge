---
name: exeris-ai-bridge-tool-family-purity-review
description: Tool family discipline review for exeris-ai-bridge. Use whenever a new tool is added, an existing tool is renamed/moved, or a new family is proposed.
---

# Exeris AI Bridge Tool Family Purity Review

## Purpose
Enforce the three-family scope (`docs:*` / `lsp:*` / `kernel:*`). Names are namespaced, scope stays inside the family, and new families require ADR-025 amendment.

## When to Use
- Any PR adding a new tool name.
- Any PR moving a tool between families.
- Any PR proposing a new family (`caps:*`, `sku:*`, etc.).
- Any PR whose tool would cross families.

## Required Inputs
- PR diff scoped to `src/tools/<family>/`.
- Tool name(s) added / changed / moved.
- Source coupling (filesystem / LSP / kernel adapter).

## Review Procedure
1. **Namespace audit** — tool name MUST match `<family>:<name>` with family ∈ {`docs`, `lsp`, `kernel`}. Unprefixed names are a hard reject.
2. **Family-scope audit** — source coupling MUST match family:
   - `docs:*` reads from `EXERIS_DOCS_ROOT` filesystem only.
   - `lsp:*` proxies `exeris-platform-lsp` via JSON-RPC only.
   - `kernel:*` queries the kernel via `KernelDiagnostics` stdio adapter only.
   A `docs:*` tool reading kernel state is a hard reject; refactor to two well-scoped tools.
3. **Registry composition audit** — the tool MUST register via `register<Family>Tools()` from `src/tools/<family>/index.ts`. Direct registration in `src/server.ts` is a regression.
4. **New family check** — if a new family is proposed, require ADR-025 amendment or successor ADR cited. Do not allow unilateral family creation.
5. **Decision and report** — `APPROVE` / `CONDITIONAL` / `REJECT`.

## Decision Logic
- **APPROVE**: Namespaced, source-coupling matches, registry composition correct.
- **CONDITIONAL**: Sound but tool description / docs need an entry; recommend the doc addition.
- **REJECT**: Unprefixed name, cross-family scope, server.ts direct registration, unilateral new family.

## Completion Criteria
- Namespace, scope, source coupling, registry composition audited.
- New-family ADR requirement determined.
- Verdict and remediation recorded.

## Review Output Template
1. **Scope analysed** (tools touched)
2. **Namespace findings** (every tool under `<family>:<name>`?)
3. **Family-scope findings** (source coupling matches family)
4. **Registry composition** (via `register<Family>Tools()`?)
5. **New family proposal** (none / ADR amendment required)
6. **Verdict** (`APPROVE` / `CONDITIONAL` / `REJECT`)
7. **Required actions** (precise and minimal)

## Non-Negotiable Rules
- Never approve an unprefixed tool name.
- Never approve a cross-family tool.
- Never approve a unilateral new family.
