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
4. **Filesystem reads are sandboxed to known roots.** The `docs:*` family reads `../exeris-docs/`; the bundled reference corpus reads `<packageRoot>/data/`. Never accept an absolute path from the agent and read it — always resolve relative to a pinned root, and verify the resolved path stays inside that root. This applies to paths *we* generate too: the bundle manifest is ours, but it is still a file on disk that a later step could rewrite, so entry paths are sandbox-checked like any other.
5. **`data/` is generated, never committed.** `prepack` runs `scripts/vendor-reference-data.mjs`, which rebuilds the bundle from released upstream artifacts and verifies every digest. Do not hand-edit `data/`, do not commit it, and do not add placeholder content to it — an empty manifest is a valid, honest state, and a missing bundle is the normal case when running from source.
6. **JSON-RPC to LSP, JSON-over-stdio to kernel adapter.** Don't invent new wire formats. The LSP server already speaks JSON-RPC; the kernel adapter uses newline-delimited JSON over stdio per the `KernelDiagnostics` contract (ADR-025 2026-06-25 amendment).
7. **Tool names are `family-tool` on the wire; `family:*` stays the prose name for a family in docs.** MCP clients do not reliably resolve a `:` inside a tool name, so the registered name is `docs-get_adr`, not `docs:get_adr`. The family prefix stays load-bearing by convention rather than by construction: `guard()` is handed its `ToolFamily` explicitly, and it is the tests that split the registered name on the first `-` and assert the halves agree with the family the handler was bound to. So a tool name is exactly one family, one hyphen, then `snake_case` — a second hyphen would silently split into the wrong family key. A test holds the whole surface to `^[a-z]+-[a-z_]+$`; do not weaken it to accommodate a name that wants a second hyphen. The `family:*` spelling is for *documentation* — this file, `README.md`, `ROADMAP.md`, ADR-025 — where it names a family as a concept. Strings the **agent** reads at runtime use the wire form instead (`unavailableResult` says `docs-*`), because the agent's only handle on a family is the tool names it can actually see in `tools/list`.

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
| `kernel:*` | Provider registry, bootstrap/subsystem DAG, per-subsystem detail — read-only (**cap-blind**; no capability composition) | Running kernel via `KernelDiagnostics` |
| `sdk:*`    | *(planned 0.6.0)* Annotation catalog, attribute contracts, `@Field`/`@Validation` scoping, deprecations, AST schema — read-only | Released `exeris-sdk` artifacts, vendored into the package at release |
| `build:*`  | *(planned 0.7.0)* The **user's own project**: emitted `DomainMetadata`, artefact preview, L1/L2 detach state, decoded processor diagnostics — read-only | User's project filesystem, pinned project root |
| `caps:*`   | *(planned 0.7.0)* `cap-manifest.json` + `CompositionStamp` — read-only; reads manifests, never re-resolves the `@Requires`→`@Provides` DAG | Build-time artefacts from `exeris-tooling` |
| `bridge:*` | The **bridge itself**, not Exeris: resolved persona mode, per-family availability with reason + remedy, child-process state. Read-only, **zero spawns**, frozen at 2 tools | This server's own boot-time state |

New families require an ADR-025 amendment (or a successor ADR). Do not invent a `sku:*` family unilaterally. `sdk:*`, `build:*` and `caps:*` are authorised by the 2026-08-16 "Two Personas" amendment — `caps:*` specifically satisfies the deferred-composition clause of the 2026-06-17 cap-blind amendment. Their tools are **not yet implemented**; adding one is milestone work, not a free-for-all. `bridge:*` is authorised by the 2026-08-26 addendum and is **frozen at two tools**; it is also the one family that is never environment-gated, which is why it is excluded from the `ToolFamily` union the availability guard ranges over — "gate `bridge:*`" should stay inexpressible rather than merely discouraged.

## Two personas — who a change is for

Per the ADR-025 2026-08-16 amendment, the bridge serves two co-equal audiences. Name which one a change serves before designing it:

- **P1 — ecosystem contributor.** Works *on* Exeris, has every sibling repo checked out. Served by `docs:*` / `kernel:*` / `lsp:*`.
- **P2 — application developer.** Builds *on* Exeris, has **no ecosystem checkout** — only a Maven dependency on `eu.exeris:*` and their own sources. Served by `sdk:*` / `build:*` / `caps:*`.

**Zero-checkout is a hard requirement, not a nicety.** Any change to config resolution must keep the server booting on a machine with no `exeris-docs`, no `exeris-platform`, no `exeris-kernel` on disk. A missing root disables its family with a structured error; it never throws out of config load. `ecosystemRoot` is optional — never assume it exists.

This is enforced, not merely stated: `scripts/p2-smoke.mjs` (CI job `p2-smoke`, `npm run smoke:p2` — it refuses a bare `node scripts/…` invocation) packs the real tarball, installs it into a scratch directory holding only an application project, points `HOME` at an empty directory and scrubs every `EXERIS_*` variable. **If you change config resolution, packaging (`files`, `bin`, `prepack`), or the launch ladder, run it** — the unit suite runs inside an ecosystem checkout and cannot see a zero-checkout regression. Its `assertZeroCheckout` guard exists because the test can go vacuous silently: the install-neighbour docs default resolving would make every assertion below it pass while testing nothing.

## Preview, never write

Hard constraint 3 forbids mutating kernel state; the 2026-06-24 amendment extended read-only across **all** families and forbids consuming `exeris/applyMutation`. The 2026-08-16 amendment keeps that intact and adds the one sanctioned path to canonical edits: `lsp-preview_mutation` consumes the read-only `exeris/previewMutation`, which applies a `MutationOp` **in memory** and returns a diff — the agent writes the file with its own tools.

No tool handler may write into the user's project. If you find yourself reaching for `fs.writeFile` against a project path, stop: that is `lsp-apply_mutation`, it is deliberately deferred past 1.0, and it needs a further amendment first.

## When to consult cross-repo ADRs

- **ADR-006** — every PR that adds a dependency or extends `kernel:*` tooling.
- **ADR-020** — every PR that adds or changes documentation cross-references.
- **ADR-023** — when someone proposes changing the license or wrapping this in commercial terms.
- **ADR-024** — its 2026-06-17 "Validation Stamp Lifecycle" amendment makes the open kernel **cap-blind**. `kernel:*` MUST NOT surface capability composition (there is no `kernel-list_capabilities`). Any future composition surface sources from `exeris-tooling` build-time artefacts (`cap-manifest.json` + composition manifest) and/or the `exeris-platform` composition runtime, and needs its own ADR-025 amendment first. See ADR-025 §"`kernel:*` Is Cap-Blind".
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
