---
name: exeris-ai-bridge-wall-process-boundary-review
description: The Wall by construction review for exeris-ai-bridge. Use whenever a dep, transport, or kernel-integration change could even theoretically link the TS/Node process into the Java kernel classpath.
---

# Exeris AI Bridge Wall / Process-Boundary Review

## Purpose
Enforce: this repo is TS / Node 20+; it MUST NOT link Java kernel classpath. Kernel access is process-boundary only (JSON-over-stdio against `KernelDiagnostics` adapter).

This is The Wall enforced by construction (ADR-006 + ADR-025 §Concrete obligations item 4). Process boundary makes it physically impossible to violate even by accident — that's the design.

## When to Use
- Any PR adding a dependency to `package.json`.
- Any PR touching the kernel integration path (`src/tools/kernel/**`, future `src/transport/kernel-adapter.ts`).
- Any PR proposing GraalVM, JNI, JNR, native-image embedding, or in-process Java invocation.
- Any PR whose stated motivation is "ergonomic kernel access" or "avoid the stdio adapter overhead".

## Required Inputs
- PR diff scoped to deps / transport / kernel integration.
- Motivation: why this path instead of stdio adapter?
- Cross-repo coordination story: is there a companion PR in `exeris-kernel`?

## Review Procedure
1. **Dep audit** — list new compile / runtime deps. Reject anything that bundles Java bytecode, links a JVM, or embeds GraalVM / JNI / JNR.
2. **Transport audit** — kernel access MUST be JSON-over-stdio against a child process. Reject in-process Java invocation paths.
3. **`KernelDiagnostics` alignment** — kernel-side surface MUST come from `KernelDiagnostics` SPI (currently RFC). If the PR depends on a not-yet-shipped SPI shape, mark blocked on cross-repo.
4. **Motivation audit** — if the motivation is "avoid stdio overhead", the right answer is "extend `KernelDiagnostics` to expose what you need" + "wrap on this side", NOT "let's embed the JVM".
5. **ADR check** — any in-process Java path requires a NEW ADR overriding ADR-025. Don't silently allow.
6. **Decision and report** — `APPROVE` / `CONDITIONAL` / `REJECT`.

## Decision Logic
- **APPROVE**: Process-boundary preserved, no JVM-linking deps, `KernelDiagnostics`-aligned.
- **CONDITIONAL**: Blocked on cross-repo SPI shape; route through `exeris-ai-bridge-docs-adr` to coordinate.
- **REJECT**: Any JVM-linking dep, any in-process Java path, any "let's just call Java directly" motivation.

## Completion Criteria
- Deps enumerated and audited.
- Transport audited.
- `KernelDiagnostics` alignment confirmed.
- ADR requirement determined.
- Verdict and remediation recorded.

## Review Output Template
1. **Scope analysed** (deps, transport, kernel integration files)
2. **Dep findings** (added deps, JVM-linking risk)
3. **Transport findings** (process-boundary preserved?)
4. **`KernelDiagnostics` alignment** (cross-repo status)
5. **ADR requirement** (none / new ADR required)
6. **Verdict** (`APPROVE` / `CONDITIONAL` / `REJECT`)
7. **Required actions** (precise and minimal)

## Non-Negotiable Rules
- Never approve a JVM-linking dep.
- Never approve an in-process Java path.
- Never accept "stdio overhead" as a reason to break the process boundary.
