# CLAUDE.md — exeris-ai-bridge

Guardrails for AI assistants working inside `~/exeris-systems/exeris-ai-bridge/`. Human-facing description lives in [`README.md`](README.md); this file captures the constraints, conventions, and "what to do when" rules an AI session must respect.

## What this repo is — load-bearing facts

`exeris-ai-bridge` is a Model Context Protocol server that publishes three surfaces from the Exeris ecosystem to AI agents: **docs/ADR registry**, **Studio/LSP bridge**, and **kernel introspection**. The founding decision is [`docs/adr/ADR-025-ai-agent-bridge.md`](docs/adr/ADR-025-ai-agent-bridge.md) — read it first when in doubt.

This repo is the **twentieth active sibling** under `~/exeris-systems/`. It is NOT part of the kernel substrate (Tier 1), NOT a capability (Tier 2), NOT a SKU (Tier 3) — it is developer-facing tooling, structurally closer to `exeris-tooling` than anything else in the ecosystem.

## Hard constraints

These are not negotiable. They derive from cross-repo ADRs and from ADR-025 itself.

1. **The Wall (ADR-006) — by construction.** This repo is TypeScript and runs in Node. It MUST NOT and CANNOT link into the Java kernel classpath. Any kernel introspection happens through a process boundary (JSON-over-stdio adapter to the `KernelDiagnostics` SPI). If you find yourself reaching for Java interop (GraalVM, JNI, JNR), stop and re-read ADR-006 + ADR-025 §Concrete obligations item 4.
2. **No model API calls.** The bridge is the *server* side of MCP. The agent (Claude, Cursor, etc.) is the client and the LLM lives there. NEVER add `@anthropic-ai/sdk`, `openai`, or any model SDK as a dependency. No model API keys live in this repo.
3. **No mutation of kernel state.** The `kernel:*` tool family is **read-only**. `KernelDiagnostics` is a read-only SPI by design. If a proposed tool would let an agent restart a subsystem, swap a provider, or modify config, push back — that belongs in a separate operator surface, not this bridge.
4. **Not a capability.** Do NOT add `@Provides` / `@Requires` annotations. Do NOT add this repo to a composition manifest. Do NOT add a dependency from `exeris-caps-*` to this repo. If someone proposes any of these, point them at ADR-025 §Concrete obligations item 5.
5. **License: Apache 2.0.** Do not change. Do not add `Commons Clause`, `BSL`, or other source-available modifiers. Commercial protection happens at the capability and SKU layer per ADR-023, not here.

## Strong defaults

These can be overridden with explicit justification, but the default is the path of least surprise.

1. **TypeScript strict mode stays on.** `tsconfig.json` has `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Disabling any of these in CI or per-file `@ts-ignore` requires a comment explaining why.
2. **Stdio transport first, SSE later.** The MCP server is invoked as a child process by the agent. Only add SSE/HTTP transport when there is a real hosted-deployment need; don't preemptively complicate the transport layer.
3. **Tool definitions live next to their handlers.** Each `src/tools/<family>/index.ts` registers its own tools and exports a `register<Family>Tools()` function. The server entry composes the registries — it does not know individual tool names.
4. **Filesystem reads are sandboxed to known roots.** The `docs:*` family reads `../exeris-docs/`. Never accept an absolute path from the agent and read it — always resolve relative to a pinned root, and verify the resolved path stays inside that root.
5. **JSON-RPC to LSP, JSON-over-stdio to kernel adapter.** Don't invent new wire formats. The LSP server already speaks JSON-RPC; the kernel adapter (when it lands) will use newline-delimited JSON over stdio per the `KernelDiagnostics` RFC.

## Scoped bans

- **Spring, IoC containers, decorators-as-DI.** This is a Node project and it stays simple — `import` is the dependency mechanism, not a framework.
- **`eval`, `new Function(...)`, dynamic `require` of user-controlled paths.** Agent-supplied strings reach tool handlers; never compile them as code.
- **Bundled binary dependencies of the kernel.** This repo does not ship kernel jars. It talks to a kernel the user runs separately.

## Tool family scope

Each tool family is documented in its own folder. Keep the scope tight; if a tool would cross families, refactor first.

| Family    | Scope                                                                                | Source                                |
|:----------|:--------------------------------------------------------------------------------------|:--------------------------------------|
| `docs:*`   | ADR registry, HLA, whitepaper, templates — read-only                                  | `../exeris-docs/` filesystem          |
| `lsp:*`    | `@ExerisDomain` source model, action signatures, codegen artefacts — read-only        | `exeris-platform-lsp` via JSON-RPC    |
| `kernel:*` | Provider registry, subsystem DAG, capability composition — read-only                  | Running kernel via `KernelDiagnostics` |

New families require an ADR-025 amendment (or a successor ADR). Do not invent a `caps:*` or `sku:*` family unilaterally.

## When to consult cross-repo ADRs

- **ADR-006** — every PR that adds a dependency or extends `kernel:*` tooling.
- **ADR-020** — every PR that adds or changes documentation cross-references.
- **ADR-023** — when someone proposes changing the license or wrapping this in commercial terms.
- **ADR-024** — when implementing `kernel:list_capabilities` or any tool that surfaces composition state.
- **ADR-025** — every architectural change. This is the founding ADR; treat amendments to it like amendments to a constitution.

## Documentation precedence

When sources disagree:

1. ADR-025 (founding decision for this repo).
2. Cross-repo ADRs in `../exeris-docs/adr/` (ADR-006, ADR-020, ADR-023, ADR-024).
3. The top-level `~/exeris-systems/CLAUDE.md` routing rules.
4. This file.
5. `README.md`.

Higher source wins; lower source is a doc-drift task.

## Language

English everywhere — source, comments, commit messages, PR titles, ADRs, this file. Conversation with the founder happens in Polish; persisted artefacts are English.

## Auto-memory

Persistent memory for this workspace lives at `~/.claude/projects/-home-arkstack-exeris-systems-exeris-ai-bridge/memory/` (created lazily when first used). Per top-level `~/exeris-systems/CLAUDE.md`, when a session is opened *inside* this repo, that memory directory overrides the parent `~/.claude/projects/-home-arkstack-exeris-systems/memory/`.
