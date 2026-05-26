---
description: Audit a dep / transport / kernel-integration change against The Wall by construction. TS/Node process MUST NOT link Java kernel classpath.
argument-hint: PR diff or package.json / `src/tools/kernel/**` change to audit
---

Audit this change against The Wall (ADR-006 + ADR-025).

Wall rules for `exeris-ai-bridge`:
- This repo is TypeScript and runs in Node 20+.
- It MUST NOT and CANNOT link into the Java kernel classpath.
- Kernel access happens through a process boundary (JSON-over-stdio adapter against `KernelDiagnostics` SPI, future `exeris-kernel-diagnostics-cli`).
- GraalVM, JNI, JNR, native-image embedding, or any "let's just call the Java side directly" path is a hard reject.

Change:
$ARGUMENTS

Please review:
1. Does this change add a dep / transport / handler that would link or embed Java code?
2. Does it propose a wire path other than JSON-over-stdio against `KernelDiagnostics`?
3. If the motivation is "ergonomic kernel access", is the right answer "extend `KernelDiagnostics` SPI in `exeris-kernel`" + "expose via cli adapter" + "wrap on this side"?
4. Is the change consistent with ADR-025 §Concrete obligations item 4 (process boundary)?
5. Minimal correction if the Wall is at risk.

A genuine in-process Java path requires a NEW ADR overriding ADR-025. Do not silently allow it.
