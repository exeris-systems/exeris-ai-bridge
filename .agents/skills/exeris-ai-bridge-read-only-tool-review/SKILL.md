---
name: exeris-ai-bridge-read-only-tool-review
description: Read-only discipline review for MCP tool handlers in exeris-ai-bridge. Use on every new/changed tool handler to refuse mutation surfaces.
---

# Exeris AI Bridge Read-Only Tool Review

## Purpose
Enforce: every tool exposed by the bridge is read-only. `KernelDiagnostics` is read-only by design. `lsp:*` does not proxy mutation. `docs:*` does not write.

Mutation surfaces belong on a separate operator surface, not the agent bridge.

## When to Use
- Any PR adding a new tool handler.
- Any PR changing the behaviour of an existing handler.
- Any PR adding a transport method that could be invoked from a handler.

## Required Inputs
- PR diff scoped to `src/tools/<family>/`.
- Handler input schema.
- Underlying transport call (filesystem read / LSP request / kernel adapter request).

## Review Procedure
1. **Name audit** — tool names should be reads (`list_*`, `get_*`, `describe_*`, `search_*`, `find_*`). Names with verbs like `apply_`, `set_`, `restart_`, `swap_`, `write_`, `delete_`, `mutate_` are red flags.
2. **Input schema audit** — does the input carry a payload that names a side effect (e.g. `MutationOp`, `ConfigOverride`, `Action`)?
3. **Body audit** — does the body call a transport method whose contract is mutation (LSP `workspace/applyEdit`, custom `exeris/applyMutation`, kernel control plane)? Reject.
4. **Prompt-injection surface** — could an agent prompt-inject this handler into a destructive call (e.g. handler accepts a free-form command string)? Reject.
5. **Cross-family check** — if motivation is "we need to mutate X", the right answer is "that's not this repo's job; route through the operator surface for X".
6. **Decision and report** — `APPROVE` / `CONDITIONAL` / `REJECT`.

## Decision Logic
- **APPROVE**: Tool name, input schema, body, and transport are all read-only; no prompt-injection vector to mutation.
- **CONDITIONAL**: Read-only intent but tool name suggests mutation — recommend rename for clarity.
- **REJECT**: Any mutation in name, schema, body, or transport.

## Completion Criteria
- Name, schema, body, transport audited.
- Prompt-injection vector classified.
- Verdict and remediation recorded.

## Review Output Template
1. **Scope analysed** (tools touched)
2. **Name findings** (verb classification)
3. **Schema findings** (mutation-payload risk)
4. **Body findings** (transport call contract)
5. **Prompt-injection surface** (yes / no)
6. **Verdict** (`APPROVE` / `CONDITIONAL` / `REJECT`)
7. **Required actions** (precise and minimal)

## Non-Negotiable Rules
- Never approve a mutation-named handler.
- Never approve a handler that calls a mutation transport method.
- Never accept "the agent will only call it for reads" — naming + schema must enforce read-only.
