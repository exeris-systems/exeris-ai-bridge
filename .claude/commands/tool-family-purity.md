---
description: Enforce the three-family scope (`docs:*` / `lsp:*` / `kernel:*`) and refuse unilateral new families.
argument-hint: PR diff or new tool name to audit
---

Audit this tool name / family change.

Family rules:
- The three tool families are deliberate (per ADR-025):
  - `docs:*` — ADR registry, HLA, whitepaper, templates; read from `../exeris-docs/` filesystem
  - `lsp:*` — `@ExerisDomain` source model, action signatures, codegen artefacts; proxy `exeris-platform-lsp` via JSON-RPC
  - `kernel:*` — provider registry, subsystem DAG, capability composition; running kernel via `KernelDiagnostics`
- Every tool name is `<family>:<name>` with family ∈ {`docs`, `lsp`, `kernel`}.
- A tool whose scope would cross families is a refactor signal — split into two well-scoped tools.
- New families (`caps:*`, `sku:*`, etc.) require an ADR-025 amendment or a successor ADR.

Change:
$ARGUMENTS

Please review:
1. Is the tool name `<family>:<name>` with a valid family prefix?
2. Does the tool's source coupling match its family (filesystem for `docs:*`, LSP for `lsp:*`, kernel adapter for `kernel:*`)?
3. Does the tool scope stay inside one family, or does it cross?
4. If a new family is proposed — is there an ADR-025 amendment or successor ADR cited?
5. Does the tool register via `register<Family>Tools()` from `src/tools/<family>/index.ts`?
6. Minimal correction if family discipline is at risk.

Unprefixed tool names and unilateral new families are hard rejects.
