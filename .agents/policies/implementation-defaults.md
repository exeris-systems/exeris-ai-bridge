---
title: "Policy — implementation defaults"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-29
---

# Policy — implementation defaults

Strong defaults. Each can be overridden with explicit justification, but the default is the path of
least surprise, and an override carries its reason where the override is made.

1. **TypeScript strict mode stays on, and the lint is type-aware.** `tsconfig.json` has `strict`,
   `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Disabling any of these in CI or a
   per-file `@ts-ignore` requires a comment explaining why. `eslint.config.mjs` runs
   `recommendedTypeChecked` on top, for the class the compiler is not looking for — a floating
   promise, a value that has quietly become `any`, an assertion that asserts nothing. Its
   relaxations are **scoped and argued in the config, never global**: `require-await` is off only
   under `src/tools/**`, where every handler satisfies a `Promise`-returning signature MCP mandates;
   the `any` and `no-unsafe-*` family is off only in `**/*.test.ts`, where asserting about untyped
   wire data is the premise rather than a defect. Widening one of those scopes, or adding a rule to
   them, needs the same kind of reason the existing ones carry.
2. **Stdio transport first, SSE later.** The MCP server is invoked as a child process by the agent.
   SSE/HTTP transport lands only when there is a real hosted-deployment need; the transport layer is
   not complicated preemptively.
3. **JSON-RPC to LSP, JSON-over-stdio to the kernel adapter.** No new wire formats. The LSP server
   already speaks JSON-RPC; the kernel adapter uses newline-delimited JSON over stdio per the
   `KernelDiagnostics` contract (ADR-025 2026-06-25 amendment).
4. **`data/` is generated, never committed.** `prepack` runs `scripts/vendor-reference-data.mjs`,
   which rebuilds the bundle from released upstream artifacts and verifies every digest. Do not
   hand-edit `data/`, do not commit it, and do not add placeholder content to it — an empty
   manifest is a valid, honest state, and a missing bundle is the normal case when running from
   source.

Tool naming and registration are in [`tool-surface`](tool-surface.md); path handling is in
[`filesystem-sandbox`](filesystem-sandbox.md).
