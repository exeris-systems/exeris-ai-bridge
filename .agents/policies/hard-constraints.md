---
title: "Policy — hard constraints of exeris-ai-bridge"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-04
---

# Policy — hard constraints

Not negotiable. They derive from cross-repo ADRs and from
[ADR-025](../../docs/adr/ADR-025-ai-agent-bridge.md) itself; a change here is a change to ADR-025,
not to this file.

## The five constraints

1. **The Wall (ADR-006) — by construction.** This repository is TypeScript and runs in Node. It
   MUST NOT and CANNOT link into the Java kernel classpath. Any kernel introspection happens through
   a process boundary (JSON-over-stdio adapter to the `KernelDiagnostics` SPI). Reaching for Java
   interop (GraalVM, JNI, JNR) is the signal to stop and re-read ADR-006 and ADR-025 §Concrete
   obligations item 4.
2. **No model API calls.** The bridge is the *server* side of MCP. The agent (Claude, Cursor, etc.)
   is the client and the LLM lives there. Never add `@anthropic-ai/sdk`, `openai`, or any model SDK
   as a dependency. No model API keys live in this repository.
3. **No mutation of kernel state.** The `kernel:*` family is **read-only**; `KernelDiagnostics` is a
   read-only SPI by design. A tool that would let an agent restart a subsystem, swap a provider, or
   modify config is refused — it belongs in a separate operator surface, not this bridge.
4. **Not a capability.** No `@Provides` / `@Requires` annotations, no entry in a composition
   manifest, no dependency from `exeris-caps-*` onto this repository. ADR-025 §Concrete obligations
   item 5 is the answer to anyone proposing one.
5. **License: Apache 2.0.** Unchanged. No `Commons Clause`, `BSL`, or other source-available
   modifier. Commercial protection happens at the capability and SKU layer per ADR-023, not here.

## Preview, never write

Constraint 3 forbids mutating kernel state; the ADR-025 2026-06-24 amendment extends read-only
across **all** families and forbids consuming `exeris/applyMutation`. The 2026-08-16 amendment keeps
that intact and adds the one sanctioned path to canonical edits: `lsp-preview_mutation` consumes the
read-only `exeris/previewMutation`, which applies a `MutationOp` **in memory** and returns a diff —
the agent writes the file with its own tools.

No tool handler writes into the user's project. The one directory the bridge writes is its own:
`build-preview_generation` sends the generator's output to a directory it creates under the OS
temporary directory, outside the project and ecosystem roots, and removes it when the call returns
(ADR-025 2026-10-04 amendment). `fs.writeFile` against a project path is
`lsp-apply_mutation`: deliberately deferred past 1.0, and it needs a further amendment first.

## Scoped bans

- **Spring, IoC containers, decorators-as-DI.** This is a Node project and it stays simple —
  `import` is the dependency mechanism, not a framework.
- **`eval`, `new Function(...)`, dynamic `require` of user-controlled paths.** Agent-supplied
  strings reach tool handlers; they are never compiled as code.
- **Bundled binary dependencies of the kernel.** This repository does not ship kernel jars. It
  talks to a kernel the user runs separately.
