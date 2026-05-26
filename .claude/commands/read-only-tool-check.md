---
description: Refuse any mutation surface in MCP tool handlers. `KernelDiagnostics` is read-only by design; `docs:*` and `lsp:*` are read-only too.
argument-hint: PR diff or new/changed tool handler to audit
---

Audit this tool handler for read-only discipline.

Read-only rules:
- All MCP tools exposed by the bridge are read-only.
- `kernel:*` cannot restart a subsystem, swap a provider, change config, or trigger lifecycle transitions.
- `lsp:*` does not mutate workspace state — that's `exeris/applyMutation` in `exeris-platform-lsp`, which is NOT proxied here.
- `docs:*` is filesystem-bound read; never writes to `../exeris-docs/`.
- Mutation surfaces belong on a separate operator surface, not this bridge.

Change:
$ARGUMENTS

Please review:
1. Does this handler accept a parameter that names a side effect (restart, reset, set, apply, mutate, delete, write, swap)?
2. Does it call into a transport method whose contract is mutation (LSP `workspace/applyEdit`, custom `exeris/applyMutation`, kernel control plane)?
3. If the proposed name is "list_*", "get_*", "describe_*", "search_*" — does the body actually only read?
4. Could an agent prompt-inject this handler into doing something destructive?
5. Minimal correction if mutation is being introduced.

A genuine mutation requirement is OUT OF SCOPE for the bridge — propose a separate operator tool instead, and cite that this is not the right repo for it.
