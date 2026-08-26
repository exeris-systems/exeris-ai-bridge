# Exeris AI Bridge — Roadmap to 1.0.0 GA

The bridge is the **agent-facing surface** of the Exeris ecosystem: an MCP server that exposes semantic surfaces — `docs:*` (ADR registry, HLA, whitepaper), `lsp:*` (Studio/LSP semantic index), `kernel:*` (read-only kernel introspection via `KernelDiagnostics`), and the authoring surfaces `sdk:*` (0.6.0), `build:*` and `caps:*` (0.7.0) — to AI agents over stdio (and later SSE).

**1.0.0 GA means: the MCP tool surface is stable.** Tool names, input schemas, and output shapes are frozen under semver. Third-party agents and IDE extensions can pin to a `@exeris/ai-bridge@^1` and trust that a 1.x bump will not break their prompts or tool-call wiring.

Founding decision: [ADR-025 — AI Agent Bridge / MCP Server for Ecosystem Introspection](docs/adr/ADR-025-ai-agent-bridge.md), as amended 2026-08-16 ("Two Personas").

This file tracks scope per milestone. Items marked `[ ]` are open; `[x]` shipped.

---

## Who this server is for — two personas

Through 0.4.0 the roadmap served exactly one of these, without ever naming it. The 2026-08-16 ADR-025 amendment names both and makes them co-equal through 1.0.

**P1 — ecosystem contributor.** Works *on* Exeris: kernel, SDK, tooling, platform. Has every sibling repo checked out under `~/exeris-systems/`. Needs the ADR registry, cross-repo routing rules, kernel runtime internals. **Served by `docs:*`, `kernel:*`, and the LSP index pointed at an ecosystem repo.**

**P2 — application developer.** Builds *on* Exeris — a product on top of the SDK + tooling. Has **no** ecosystem checkout: a Maven dependency on `eu.exeris:exeris-sdk-*`, the codegen plugin, and their own `@ExerisDomain` sources. Needs the annotation contract, what codegen will emit, why the build failed, and canonical entity edits. **Served by nothing today.**

The gap is structural, not cosmetic. Three concrete pieces of evidence:

1. **Every planned prompt was a P1 workflow** — the pre-amendment prompt list (`review-three-tier-violations`, `draft-adr`, `route-this-task`, `wall-audit`, now at 0.9.0) contained four contributor workflows and not one entity-authoring workflow.
2. **`loadConfig()` fail-fast makes P2 impossible.** `src/config/env.ts` resolves `EXERIS_DOCS_ROOT ?? ../exeris-docs` through `resolveExistingDir`, which throws when the directory is absent, and derives `ecosystemRoot = dirname(docsRoot)` — from which the default LSP and kernel-CLI launch specs are built as `mvn -f <ecosystemRoot>/…/pom.xml`. On a P2 machine there is no such tree, so **the server does not boot at all**.
3. **The write vocabulary already exists and is P2-shaped.** `MutationOp` (SDK `exeris-sdk-source-model`) has nine variants — `AddField`, `RemoveField`, `RenameField`, `ChangeFieldType`, `AddRelationship`, `RemoveRelationship`, `ChangeRelationshipCardinality`, `AddAction`, `RemoveAction` — with `SourceDigest` / `BaselineTrust` for optimistic concurrency, and `exeris/applyMutation` implements idempotent write-back platform-side. The bridge is forbidden from consuming any of it (2026-06-24 amendment). That investment currently serves Studio only.

**Read-only stays intact.** The bridge performs no write, in any family, through 1.0 — see 0.8.0, which delivers *preview* (a canonical diff the agent applies with its own file tools), not *apply*.

---

## 0.1.0 — scaffold (shipped 2026-05-15)

> Goal: repo on disk, MCP server boots, tool registry mechanism works against placeholder handlers.

- [x] Repo created as twentieth public sibling under `~/exeris-systems/`, Apache 2.0
- [x] TS 5.6+ / Node 20+ / ES2023 stack with `@modelcontextprotocol/sdk` dependency
- [x] `src/server.ts` — MCP server entry, stdio transport, tool registry composition
- [x] Three tool family placeholders (`docs:*`, `lsp:*`, `kernel:*`) — definitions land, handlers return `isError: true` "Not implemented yet"
- [x] Per-repo `CLAUDE.md` with hard constraints (The Wall, no model API calls, no mutation, not a capability, Apache 2.0)
- [x] [ADR-025](docs/adr/ADR-025-ai-agent-bridge.md) ACCEPTED; link stubs in `exeris-kernel/docs/adr/`, `exeris-platform/docs/adr/`
- [x] Sub-repo map row added in top-level `~/exeris-systems/CLAUDE.md` + routing section

## 0.2.0 — `docs:*` family + CI + first agent demo (shipped 2026-06-05)

> Goal: a running Claude Code session can call `docs:list_adrs` and `docs:get_adr 024` against this server and get correct answers from `../exeris-docs/`. Everything is filesystem-bound; zero external process dependencies.

- [x] **`git init` + first commit** in `exeris-ai-bridge/`; push to `github.com/exeris-systems/exeris-ai-bridge` (public repo creation)
- [x] **CI** — `.github/workflows/build.yml`: `npm ci` → `npm run typecheck` → `npm run build` → `npm test` on Node 20 and 22
- [x] **`docs:list_adrs`** — parses `../exeris-docs/adr-index.md` markdown table, returns `{ number, title, owningRepo, scope, visibility, status, link }[]`; supports optional `status` filter. `link.github` carries the public GitHub URL (null for enterprise-private)
- [x] **`docs:get_adr`** — resolves ADR-NNN by number against the index, reads the authoritative file (handles cross-repo paths), returns full markdown body
- [x] **`docs:get_template`** — fetches `templates/{ADR,RFC,RESEARCH}-TEMPLATE.md` by name
- [x] **`docs:get_hla`** + **`docs:get_whitepaper`** — return canonical narrative docs
- [x] **`docs:search`** — pure-JS literal-substring scan over `EXERIS_DOCS_ROOT` (no ripgrep dep) with `maxResults` (default 50, cap 200), `pathFilter`, and per-file / total-bytes / files-visited safety caps
- [x] **`docs:list_repos`** + **`docs:list_repo_docs`** + **`docs:get_repo_doc`** — per-repo non-ADR docs surface (subsystem docs, RFCs, design notes under `<repo>/docs/**`). `adr/` subtree excluded; agents must use `docs:get_adr` for ADRs so the registry's visibility / sandbox / cross-repo flow stays uniform. Scope addition to the original §0.2.0 list — sibling repos publish non-ADR docs (`exeris-kernel/docs/subsystems/`, `exeris-spring-runtime/docs/architecture/`, etc.) that the agent should be able to reach without per-tool plumbing
- [x] **Path-sandbox guard** — every filesystem read resolves under a configured root and rejects paths that escape it (path-traversal hardening from day 1)
- [x] **`EXERIS_DOCS_ROOT` env var** — points at the `exeris-docs/` checkout; sensible default for the monorepo-neighbour layout (`../exeris-docs` relative to the bridge install)
- [x] **Unit tests** for every tool handler (parsing, filtering, sandbox enforcement) using `node --test` — 128 tests covering env, sandbox, adr-index parser, all nine `docs:*` handlers, redactEcosystemPaths, and formatSandboxStderrLine
- [x] **First end-to-end demo** — `.claude/settings.json` config snippet (incl. `EXERIS_DOCS_ROOT` env) committed to README under [Try it](README.md#try-it-end-to-end); manual smoke confirmed: stdio JSON-RPC `initialize` → `tools/list` (13 defs) → `docs:get_adr {number:24}` returns the ADR-024 body, `docs:search "ADR-024"` returns hits, `docs:list_adrs` returns 37 structured rows
- [x] **npm publish dry-run** — version bumped `0.2.0-SNAPSHOT` → `0.2.0`; `npm pack --dry-run` reviewed (39 files, ~35 kB, no test/spec artefacts, README + LICENSE included); `npm publish --dry-run` resolves `@exeris/ai-bridge@0.2.0` (tag `latest`, public access). Actual publish/tag is a separate deliberate release step

## 0.3.0 — `lsp:*` family ✅ (closed 2026-06-24)

> Goal: the bridge proxies `exeris-platform-lsp` over JSON-RPC. Agents can ask the bridge about `@ExerisDomain` types and get answers grounded in the same semantic index Studio uses.

> **Phase 3a (shipped 2026-06-05) — bridge-side scaffolding.** The transport, discovery, and resilient error model landed independently of the companion.
>
> **Phase 3b (2026-06-24) — companion bound.** The read-only `exeris/*` slice landed in `exeris-platform` (`feat/lsp-readonly-slice`): methods `exeris/domains` / `exeris/domainDescribe` / `exeris/actions` (renamed from the `workspace/exeris*` working names). The bridge now targets those names and validates each result against its wire shape (`src/tools/lsp/shapes.ts`), re-emitting only the contract fields. The method names + payload shapes are pinned by the ADR-025 2026-06-24 amendment.
>
> **Phase 3c (2026-06-24) — live data path verified.** The integration test spawns a real server over stdio and exercises all three tools end-to-end. Findings: (1) the bridge now sends `rootUri` from `EXERIS_LSP_WORKSPACE` (default: cwd) — without it the server indexes an empty tree; (2) the default `exec:java` launch keeps the JSON-RPC stdout clean, so **the historical `exec:java`-shares-stdout caveat is retired**; (3) a void action's `resultType` (and a non-HTTP action's `httpMethod`) come back absent — LSP4J/Gson omits null Strings — so those fields are now `string | null` in the validated shape.

- [x] **LSP transport layer** — `src/transport/lsp-client.ts`: JSON-RPC client over the LSP base-protocol framing (`src/transport/lsp-framing.ts`) against a child `exeris-platform-lsp` process; lazy spawn, `initialize` handshake, id correlation, per-request timeout, typed `LspRequestError` / `LspTransportError`
- [x] **LSP server discovery** — `EXERIS_LSP_COMMAND` env var (default: `mvn -q -f <ecosystemRoot>/exeris-platform/exeris-platform-lsp/pom.xml exec:java`); lazy spawn on first `lsp:*` call; cached handle. *Verified by the integration test: with `-q`, Maven keeps its logging off the JSON-RPC stdout (JVM warnings go to stderr), so the default launch is clean — the historical `exec:java`-shares-stdout caveat is retired. `exec:exec` / direct-jar stays a documented fallback.*
- [x] **LSP workspace root** — `EXERIS_LSP_WORKSPACE` env var (default: the bridge's cwd) sent as `initialize` `rootUri`; the server walks this tree for `@ExerisDomain` sources. Without it the server indexes an empty workspace and every tool returns `[]`.
- [x] **`lsp:list_domains`** — `exeris/domains` custom request; returns validated `DomainSummary[]` (`{ qualifiedName, simpleName, packageName, sourcePath }`). *Phase 3b: bound to the companion method + shape validation.*
- [x] **`lsp:describe_domain`** — `exeris/domainDescribe` custom request (params `{ qualifiedName }`); returns validated `DomainDescription` (fields, action signatures, generated `artefacts`). *Phase 3b: bound to the companion method + shape validation.*
- [x] **`lsp:list_actions`** — `exeris/actions`; returns validated `ActionSummary[]` (each `@Action` with its `owningDomain`). *Phase 3b: bound to the companion method + shape validation.*
- [x] **Resilience** — LSP not running / crashed / framing-desync / request timeout / shape mismatch → tool returns structured error (not crash); `bridge:health` (moved to 0.5.0, shipped) surfaces the failure mode via each transport's `status()`
- [x] **Cross-repo coordination** — companion in `exeris-platform/exeris-platform-lsp/` (`feat/lsp-readonly-slice`) adding the three read-only `exeris/*` requests; the bridge-side companion (method rename + shape validation) is this Phase 3b change
- [x] **Integration test** — `src/transport/lsp-integration.test.ts`: spawns the real LSP server (default `exec:java`) against a temp fixture workspace (one `@ExerisDomain` source) and asserts all three tools' validated payloads over stdio. Opt-in (gated on `EXERIS_LSP_IT=1` + `EXERIS_LSP_COMMAND`) so the bridge's JVM-free CI stays fast. Confirmed the live data path, retired the stdout caveat, and caught the nullable `resultType`/`httpMethod` contract gap.

## 0.4.0 — `kernel:*` family ✅ (closed 2026-06-25)

> Goal: the bridge introspects a running kernel through a process-boundary adapter. Read-only. Preserves The Wall by construction. **Cap-blind** — the kernel exposes runtime state only; capability composition is a tooling/platform surface, not a kernel one (ADR-024 2026-06-17 "Validation Stamp Lifecycle" amendment; ADR-025 §"`kernel:*` Is Cap-Blind").

> **Phase 4a (2026-06-25) — adapter bound + live data path verified.** The Node-side adapter (`src/transport/kernel-adapter.ts`) spawns the shipped `exeris-kernel-diagnostics-cli` over NDJSON and the three tools validate each snapshot against its wire shape (`src/tools/kernel/shapes.ts`, mirrored 1:1 from the `eu.exeris.kernel.spi.diagnostics.*` records, `schemaVersion` "1.0"). The integration test spawns the real CLI end-to-end. Findings: (1) the id-less NDJSON protocol is correlated **FIFO**, so a request timeout / framing desync **soft-resets** the adapter (kills the child, next call re-spawns) rather than misaligning the queue or permanently bricking the family on a slow cold boot; CLI-gone (spawn-error / exit) stays sticky. (2) The default `mvn -q … exec:java` launch keeps NDJSON stdout clean (JVM/Maven logs → stderr); a `java -jar` override needs `--enable-preview` (the kernel compiles at `release 25` with preview features on) and inherits the same clean-stdout property.

- [x] **`KernelDiagnostics` SPI RFC** — `exeris-kernel/docs/rfc/RFC-2026-05-18-kernel-diagnostics-spi.md` ACCEPTED; ADR-033 ACCEPTED (read-only surface, stability contract, NDJSON adapter shape)
- [x] **`KernelDiagnostics` SPI implementation in `exeris-kernel-spi`** — interface + snapshot records (shipped exeris-kernel v0.9.0)
- [x] **Community provider in `exeris-kernel-community`** — implements the SPI against the `KernelProviders.SUBSYSTEMS` bootstrap state (inspect mode)
- [x] **`exeris-kernel-diagnostics-cli`** — Java executable; reads NDJSON requests on stdin, writes responses on stdout; the bridge spawns this as a child process
- [x] **`src/transport/kernel-adapter.ts`** — Node-side wrapper: lazy spawn, NDJSON framing (`src/transport/ndjson-framing.ts`), FIFO correlation, per-request timeout, typed `KernelRequestError` / `KernelTransportError`, hard-close vs soft-reset lifecycle. Launch spec is `EXERIS_KERNEL_COMMAND` (default: `mvn -q -f <ecosystemRoot>/exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml exec:java -Dexec.mainClass=…`)
- [x] **`kernel:list_providers`** — validated `ProvidersSnapshot` (`providers[]`: `providerName`, `spiType`, `priority`, nullable `displayName`); enumerates one Community provider per SPI domain
- [x] **`kernel:get_bootstrap_dag`** — validated `BootstrapDagSnapshot` (`nodes[]`: `name`, `phase`, `dependsOn`, `running`, `optional`)
- [x] **`kernel:describe_subsystem`** — validated `SubsystemSnapshot` (`requestedName` echoed, `subsystem` `null` for an unknown name — a clean not-found, not an error)
- [x] ~~`kernel:list_capabilities`~~ — **removed.** Capability composition is NOT a kernel surface: the open kernel is cap-blind (ADR-024 revised obligation 9). If the bridge ever surfaces composition it reads the build-time `cap-manifest.json` + composition manifest (`exeris-tooling`) and/or the `exeris-platform` composition runtime — never the kernel — and requires its own ADR-025 amendment first. *(Reconciled 2026-08-26: the build-time producer now exists — `exeris-tooling` writes `cap-manifest.json` from `CodegenPipeline` and `VerifyCapabilitiesMojo` validates it, while `exeris-sdk-composition-runtime` asserts the `CompositionStamp` at boot. A composition surface has a real source today; it is still not the kernel's.)*
- [x] **Auth-free local mode** — the kernel adapter trusts the spawning process by default; if/when remote introspection lands, auth is layered in 0.6 (SSE + transport auth)
- [x] **Integration test** — `src/transport/kernel-integration.test.ts`: spawns the real diagnostics CLI and exercises all three tools' validated payloads over NDJSON. Opt-in (gated on `EXERIS_KERNEL_IT=1` + `EXERIS_KERNEL_COMMAND`) so the bridge's JVM-free CI stays fast. Confirmed the live data path and the clean-stdout property; the FakeChannel unit suite covers FIFO, timeout soft-reset, framing desync, and sticky crash.

## 0.5.0 — zero-checkout mode (the P2 foundation)

> Goal: the bridge boots and serves useful answers on a machine that has **no ecosystem repository checked out** — only a Maven dependency on `eu.exeris:*` and the developer's own sources. Nothing in the P2 track is reachable until this lands, so it goes first.

This is a configuration and packaging milestone, not a tool milestone. No new tool family ships here.

- [x] **ADR-025 amendment "Two Personas" ACCEPTED** — gate on everything below; names P1/P2, authorises the three new families, pins the preview-not-write stance. Merged 2026-08-16 (`2b25b8b`, PR #14)
- [x] **Graceful degradation replaces fail-fast** — a missing `EXERIS_DOCS_ROOT` disables `docs:*` (tools report a structured `family_unavailable` error carrying `reason` + `remedy`) instead of throwing out of `loadConfig()`. Boot succeeds unconditionally — even with *no* family available, since a server that reports why it is dark beats one that will not start. The tool surface is invariant: `tools/list` returns the same 15 definitions either way, which is what makes the 1.0 freeze possible
- [x] **`EXERIS_BRIDGE_MODE=contributor|app|auto`** — `auto` (default) probes for an ecosystem layout and picks; explicit values pin the behaviour. `ecosystemRoot` is now `string | null` rather than load-bearing. Mode is *descriptive*, not a mask: it never switches a family off, so availability keeps exactly one source of truth (did the dependency resolve). Pinning `contributor` only changes a missing root from the expected P2 state into a reported misconfiguration
- [x] **Artifact-resolved launch specs** — a launch ladder per child: `EXERIS_*_COMMAND` → `EXERIS_*_JAR` → local-Maven-repo probe by coordinate (no network) → `mvn -f <src>/pom.xml`, only when the module pom is actually there → family unavailable. **Rung order depends on the mode**, and this is the one place mode changes behaviour rather than describing it: contributor puts the source tree first (someone with the checkout is working *on* that tree; a released jar would answer for code they are not editing, and nothing in the answer would say so), app puts the published jar first. Preference, not gating — the second rung still fires when the first cannot. The CLI version comes from the newest **release** of `exeris-kernel-core` present in the local repository — *not* from the project's dependency graph, which would need a Maven invocation and therefore a network round-trip on the boot path; those normally agree, and `EXERIS_KERNEL_VERSION` pins it when they do not. `--enable-preview` is per-artifact, not blanket: `exeris-kernel` compiles at `release 25` with preview on, `exeris-platform` at `release 26` with none. **Kernel side is already artifact-launchable** (shaded, `Main-Class` in the manifest, deployed by the root-reactor `mvn deploy`); the LSP side is the remaining **cross-repo dependency** — its published jar carries no `Main-Class` (verified 2026-08-26), so `lsp:*` has no local-repository rung until the companion ask lands — see the asks table
- [x] **Bundled reference data** — the P2-relevant read-only corpus (annotation catalog, AST schema, curated authoring guides) ships *inside* the npm package, generated at release time from released upstream artifacts. No network, no checkout. Establishes the mechanism 0.6.0 fills with content. **Ships with zero entries**, deliberately: the manifest, the loader, the integrity check and the packaging are all real, and putting placeholder content in a public package to prove a pipeline works would be shipping fiction. `data/` is generated by `prepack` and **not committed**, which keeps a stale `generatedAt` out of git and makes the bundle-absent branch the ordinary source-checkout experience rather than one only a test reaches. Every entry carries a SHA-256 verified on read (a truncated file parses fine and is quietly wrong) and a per-entry `sourceArtifact`, so an answer can name which upstream release it reflects; `bridge:version` reports the bundle state, entry count and those artifacts
- [x] **`bridge:health` + `bridge:version`** — **pulled forward from the old 0.7.0.** Zero-checkout resolution has many more failure modes than the ecosystem layout did ("which mode am I in, which families are live, why is `sdk:*` dark"); shipping the diagnostic surface *after* the thing it diagnoses is backwards. Authorised by the ADR-025 2026-08-26 addendum and frozen at two tools. **Zero spawns:** both read boot-time config plus non-spawning `status()` accessors on the two transports. The planned `probe` flag was dropped — the families' own tools already answer "can this child launch?" by doing the work, and the resulting transport state shows up in the next `bridge:health`
- [ ] **P2 smoke test** — CI job that installs the tarball into a scratch directory containing *only* a minimal Maven project with one `@ExerisDomain` source, and asserts the server boots and answers

## 0.6.0 — `sdk:*` family (the authoring contract)

> Goal: an agent writing `@ExerisDomain` code stops guessing. The annotation surface, its canonical scoping rules, and the AST wire format become queryable instead of grep-able.

The single highest-value item is the **`@Field` vs `@Validation` scoping rule**. It is the most likely place in the whole SDK to introduce a subtle regression (per `exeris-sdk/CLAUDE.md`), it is stated authoritatively in two `package-info.java` files, and today an agent finds it only by reading them. `@Validation.required` is deprecated-for-removal with a processor fallback window — an agent that guesses wrong writes code that compiles with a warning today and breaks at SDK 1.0.0.

- [ ] **`sdk:list_annotations`** — all public `@interface`s across `annotation`, `annotation.system`, `annotation.security`, `annotation.capability` (49 in the released SDK v0.10.0: 33 root, 10 `system`, 4 `capability`, 2 `security` — the unreleased `0.11.0-SNAPSHOT` line already carries 51, which is precisely why the catalog must be generated upstream rather than counted by hand here), each with `@Target`, `@Retention`, one-line purpose
- [ ] **`sdk:describe_annotation`** — full attribute list per annotation: name, type, default, required-ness, deprecation status + canonical replacement, and the prose rationale from the owning `package-info`
- [ ] **`sdk:get_scoping_rules`** — the `@Field` (shape + lifecycle) vs `@Validation` (constraints) split, `FieldMetadata` as the single AST carrier, and the derived NOT NULL / not-blank semantics, served as structured data rather than as a doc the agent must read and remember
- [ ] **`sdk:list_deprecations`** — everything `@Deprecated(forRemoval = true)` with its replacement and removal version; sourced from the SDK's own `MIGRATION.md` pipeline
- [ ] **`sdk:get_ast_schema`** — JSON Schema for `DomainMetadata` and the ~30 sibling AST records, including the two non-obvious Jackson 3 constraints (`FAIL_ON_NULL_FOR_PRIMITIVES=false`; `@JsonInclude(NON_DEFAULT)` boxed-zero behaviour)
- [ ] **Catalog generation is upstream-owned, not hand-maintained** — the SDK emits the catalog; the bridge vendors it at release. A hand-written catalog in this repo would be stale the first time an annotation attribute changes. **Cross-repo dependency** — see the asks table
- [ ] **Version-skew handling** — the bundled catalog carries the SDK version it was generated from; when the user's project pins a different one, tools say so rather than answering confidently from the wrong contract

## 0.7.0 — `build:*` and `caps:*` families (the pipeline, from the app's side)

> Goal: the agent can answer "what will this build produce, and why did it fail" about **the user's own project** — the question P2 asks all day and that no current family touches.

`build:*` is filesystem-bound and reads the user's project, so it inherits the `docs:*` path-sandbox discipline: a pinned project root, never an agent-supplied absolute path.

- [ ] **`build:get_domain_metadata`** — the processor-emitted `exeris-metadata/<entity>.json` for one entity of the user's project, validated against the AST shapes
- [ ] **`build:explain_artefacts`** — given an entity, which files the 12 kernel generators plus the TS/Angular emitters will produce, and which annotation drove each. Turns "run the build and look" into a question
- [ ] **`build:get_detach_state`** — L1 (`src/main/generated/`, regenerated) vs L2 (detached into `src/main/java/`, owned). An agent that edits a still-generated file loses the edit on the next build; this makes the distinction visible
- [ ] **`build:explain_diagnostic`** — decode a processor warning/error the developer pasted in. Covers the `-Aexeris.strict` "attribute set but no generator consumes it" audit and the deprecated-`@Validation` warn-and-read fallback. **Blocked on stable diagnostic IDs upstream** — the processor emits prefixed free text today (`DIAG_PREFIX = "[Exeris] "` across 9 `printMessage` sites, no code registry). **Cross-repo dependency** — see the asks table
- [ ] **`caps:list_capabilities`** + **`caps:describe_composition`** — read `cap-manifest.json` (schema v2) and the `CompositionStamp` (`validated`, `compositionVersion`, `contentBinding`). **This is the family the 2026-06-17 amendment pre-authorised**: it explicitly permits composition introspection sourced from *build-time* artefacts, never from the kernel, and requires "its own ADR-025 amendment" first — which the 2026-08-16 amendment supplies. `kernel:*` stays cap-blind; there is still no `kernel:list_capabilities`
- [ ] **Scope discipline** — `caps:*` reads emitted manifests only. It does **not** re-resolve the `@Requires`→`@Provides` DAG; that is `exeris-tooling`'s job and duplicating it here would be a second implementation of a validated contract
- [ ] **`caps:*` degrades cleanly on a cap-less project** — still the common case in a *user's own* project, but no longer for want of a producer: the emit → validate → assert pipeline is shipped and covered end-to-end upstream (`exeris-tooling` `CapCompositionE2ETest`, which asserts the manifest pins dependency order rather than alphabetical order). Absent manifest is a clean empty answer, not an error

## 0.8.0 — mutation preview (canonical edits, still zero writes)

> Goal: when an agent adds a field to an entity, the *canonical* SDK writer decides what the source looks like — not the agent's guess at annotation style. The bridge still never writes.

The mechanism: the agent sends a `MutationOp`, the platform applies it **in-memory** and returns the resulting diff plus a `MutationResult`; the agent writes the file with its own tools. The bridge stays literally read-only, and the idempotent write-back logic stops being Studio-only. Whether the bridge should eventually *apply* directly is deliberately deferred — see Post-1.0 candidates.

- [ ] **`lsp:preview_mutation`** — accepts one of the nine `MutationOp` variants, returns a unified diff + the `MutationResult` outcome, writing nothing to disk. Consumes a **new read-only** `exeris/previewMutation`; **does not** consume `exeris/applyMutation`, per the 2026-06-24 amendment. The op/result vocabulary is already settled upstream by **ADR-042** (`exeris-sdk`, ACCEPTED 2026-06-13), so this tool binds to a settled contract rather than negotiating one. *Settled, not yet frozen* — ADR-042 obligation 3 freezes the constant names and the JSON shape at **its** 1.0.0; the implementation has established them, which is a weaker guarantee and worth not shortening while our own freeze is the live topic. **Cross-repo dependency** — see the asks table
- [ ] **Baseline safety wired through** — the request carries the baseline *and* a concurrency token: `ApplyMutationParams(qualifiedName, op, baselineJson, concurrencyToken)`. The SDK never reads the baseline off disk, so the bridge must send it. Per **ADR-042 obligation 5** the baseline is the last-emitted `exeris-metadata/<entity>.json`, and `sourceDigest` is *one mechanism, not two* — stamped into that file for staleness control **and** passed back as the concurrency token at apply time. `schemaVersion` is stamped but never travels in a request. Drift detection is an **AST-level three-way** comparison (**obligation 4**; the textual-merge alternative was measured and rejected in RFC-2026-06-11, `LexicalPreservingPrinter` leaving an indent-only line behind), so the tool must surface all four `MutationResult` outcomes — `SUCCESS`, `CONFLICT`, `VALIDATION_ERROR`, `NO_BASELINE` (**obligation 3**) — and must not collapse `NO_BASELINE` into a conflict
  - *Two places the implementation diverges from the ADR's own prose, verified upstream 2026-08-26 — build against these, not against the ADR text:* **(a)** the stamping is done by the **annotation processor** (`ExerisDomainProcessor.buildMetadataNode`, behind the javac Compiler Tree API), not by codegen as the ADR says in four places; where that API is absent — some incremental and IDE environments — the digest is skipped and only `schemaVersion` is stamped, degrading rather than failing the build, so `build:*` must treat a digest-less baseline as normal. **(b)** `schemaVersion` is a dedicated `SchemaVersion.CURRENT` constant **decoupled from the Maven artifact version**; ADR-042 left this open and guessed "in practice this is the artifact version", and the implementation took the other branch so a release with no AST change does not read as skew. They agree today (`CURRENT` = `0.11.0` against artifact `0.11.0-SNAPSHOT`) and diverge permanently at that first release
  - *Error-path note:* the ADR maps a digest mismatch to `NO_BASELINE`, but the implementation narrowed that to **apply time** — `checkBaselineTrust` covers only missing / unparseable / schema-skew, because three-way detection by definition runs against source that has already changed. A stale digest is therefore not a detection-time block, and the bridge must not present it as one
- [ ] **Idempotence assertion in the bridge's own tests** — previewing the same op twice against the same baseline returns the same diff; previewing an already-applied op returns an empty diff. This is the bridge-side echo of the platform's idempotent-write-back contract
- [ ] **Explicit non-goal: no raw file writes.** If an implementation ever reaches for `fs.writeFile` against the user's project, it has left this milestone's scope and needs a further amendment

---


## 0.9.0 — MCP resources + prompts (both personas)

> Goal: the bridge stops being tools-only. It publishes ADRs, HLA, whitepaper as MCP **resources** (URI-addressable) and ships canned **prompts** that bootstrap an agent into common Exeris workflows.

> **Renumbered from 0.5.0** by the 2026-08-16 amendment, and rescoped: the original prompt list was four P1 workflows with no P2 counterpart. The P2 prompts below are the correction.

- [ ] **Resource registry** — `exeris://docs/adr/{NNN}`, `exeris://docs/hla`, `exeris://docs/whitepaper`, `exeris://docs/template/{ADR|RFC|RESEARCH}`
- [ ] **Resource subscriptions** — clients can subscribe to `exeris://docs/adr-index` and be notified when the registry changes (filesystem watcher)
- [ ] **Prompts**
  - [ ] `review-three-tier-violations` — pre-loads HLA §§2.2/3/4/5 + ADR-006 + ADR-024 + cap-tier Wall rule; instructs the agent to scan a diff for the ten drift patterns in `exeris-docs/CLAUDE.md`
  - [ ] `draft-adr` — pre-loads `ADR-TEMPLATE.md` + `adr-index.md` (for the next-free-number lookup); instructs the agent to ask Research/RFC/ADR shape question first
  - [ ] `route-this-task` — pre-loads the top-level routing rules from `~/exeris-systems/CLAUDE.md`; agent identifies the owning repo before touching anything
  - [ ] `wall-audit` — pre-loads ADR-006; agent scans a file/PR for Spring/Netty/servlet leakage
- [ ] **P2 prompts** — the missing half
  - [ ] `author-domain` — pre-loads the `sdk:*` scoping rules + AST schema; walks the agent through adding an `@ExerisDomain` entity with correct `@Field` / `@Validation` split, then previews the mutation instead of hand-writing it
  - [ ] `explain-my-build` — pre-loads `build:explain_artefacts` + `build:get_detach_state`; answers "what did this build produce and which of it may I edit"
  - [ ] `diagnose-build-failure` — pre-loads `build:explain_diagnostic` + the deprecation list; turns a pasted `javac` error into a fix
  - [ ] `migrate-sdk-version` — pre-loads `sdk:list_deprecations`; finds usages the next SDK bump will break
- [ ] **`prompts:list_repos`** — lookup of which repo owns which question, derived from the routing section (P1)

## 0.10.0 — SSE transport + hosted deployment

> Goal: the bridge runs as a hosted service for teams / customers who don't want to spawn a local Node process per agent. Multi-user, auth'd, observable.

- [ ] **SSE transport** — `@modelcontextprotocol/sdk` SSE server wired in alongside the existing stdio transport (selectable by `EXERIS_AI_BRIDGE_TRANSPORT=stdio|sse`)
- [ ] **Bearer-token auth** — minimal auth model for SSE; tokens stored as a hashed allowlist file or env-var allowlist
- [ ] **Per-token scoping** — token grants are scoped to tool families (`docs:*` / `sdk:*` / `lsp:*` / `build:*` / `caps:*` / `kernel:*`) so a public-docs token can't introspect a running kernel, and a P2 token can't read another tenant's project tree
- [ ] **Dockerfile** — multi-stage build, distroless final image, non-root user, `~50MB`
- [ ] **Kubernetes manifest example** — `Deployment` + `Service` + `Ingress` template under `deploy/k8s/`
- [ ] **Multi-tenancy story** — one bridge instance can front several kernel adapters (`?kernel=app-a` URL param routes to the right child); explicitly out of scope until a customer asks for it, but the design is sketched

## 0.11.0 — observability + diagnostics

> Goal: the bridge is itself observable. JFR-equivalent telemetry. Self-diagnostic surface for debugging "why isn't this tool working".

> `bridge:health` and `bridge:version` **moved to 0.5.0** — zero-checkout resolution needs them at boot, not five milestones later.

- [ ] **Tool-call telemetry** — every tool invocation produces a structured log line: `{ tool, latencyMs, status, error? }`; stdout in dev, OTLP exporter as an opt-in dependency in prod
- [ ] **Slow-tool warning** — log line + MCP server-side notification when a tool call exceeds a per-tool threshold (`docs:* > 200ms`, `sdk:* > 100ms` (bundled data), `lsp:* > 1s`, `build:* > 500ms`, `kernel:* > 500ms`)
- [ ] **Self-trace prompt** — `bridge-troubleshoot` prompt that walks an agent through diagnosing why a tool call failed
- [ ] **`bridge:health` deepening** — the 0.5.0 cut answers "which families are live"; this adds latency history and last-failure detail per family

## 0.12.0 — security review + hardening

> Goal: external security review pass. Bridge can be exposed to untrusted agents (e.g. customer's own LLM, third-party MCP clients) without exfiltration risk.

- [ ] **Path-traversal audit** — formal review of every filesystem-touching code path; fuzz tests for `../`, symlinks, Windows drive letters
- [ ] **JSON-RPC injection audit** — LSP and kernel-adapter requests must escape correctly; no template-string concat of agent-supplied identifiers
- [ ] **Dependency audit** — `npm audit` clean; SBOM published with each release; `@modelcontextprotocol/sdk` pinned to a reviewed version. *(Partially done ahead of schedule 2026-08-26: the SDK floor moved `^1.0.0` → `^1.30.0` and the tree went from 6 advisories — 3 high — to `found 0 vulnerabilities`. All of them were transitive under the SDK's HTTP stack (`hono`, `@hono/node-server`, `express`/`body-parser`, `express-rate-limit`/`ip-address`, `ajv`/`fast-uri`), which the stdio transport never executes — but 0.10.0 turns exactly that stack on. Still open here: an exact pin and the SBOM.)*
- [ ] **Resource-limit caps** — `docs:search` result size capped, `lsp:*` request budget per session capped, child-process memory limits
- [ ] **License notice** — generated `NOTICE.md` lists every third-party dep + license; CI gate fails if a non-permissive license sneaks in
- [ ] **Threat model doc** — `docs/threat-model.md` enumerating trust boundaries (agent ↔ bridge, bridge ↔ LSP, bridge ↔ kernel adapter, bridge ↔ filesystem)
- [ ] **P2 project-root confinement** — `build:*` reads the *user's proprietary source tree*, a materially higher-value target than the public `exeris-docs` corpus the sandbox was designed for. The pinned-project-root guarantee gets its own fuzz suite and its own threat-model section
- [ ] **Preview-path audit** — confirm `lsp:preview_mutation` cannot be coerced into a write: no code path from a tool handler to `fs.writeFile` against a project path, asserted by a test, not by review alone

## 0.13.0 — pre-GA polish

> Goal: every paper cut a 0.x adopter has reported is closed; docs are buyable; 1.0 surface is frozen in a release candidate.

- [ ] **Documentation site** — typedoc-generated tool reference + hand-written getting-started + IDE-integration guides (Claude Code, Cursor, Continue, Zed)
- [ ] **Example projects** — `examples/with-claude-code/`, `examples/with-cursor/`, `examples/with-mcp-inspector/`
- [ ] **`MIGRATION-0.x-to-1.0.md`** — every rename, schema change, or removal between 0.x and 1.0 enumerated
- [ ] **Release candidates** — `1.0.0-rc.1`, `rc.2` as the surface settles; community feedback window
- [ ] **Backward-compat policy doc** — `docs/compat-policy.md` makes the semver contract explicit (additive minor / breaking major / deprecation cycle length)

## 1.0.0 GA — stable MCP tool surface

> Goal: any 1.x release is source-compatible. Tool names, input schemas, output shapes don't change without a deprecation cycle.

- [ ] **Tool surface frozen** — names + input JSON Schemas + output shapes for `docs:*` (9 tools), `sdk:*` (5), `lsp:*` (3 + `preview_mutation`), `build:*` (4), `caps:*` (2), `kernel:*` (3), `bridge:*` (2) locked
- [ ] **Both personas served at freeze** — this is *why* the P2 track was renumbered ahead of the hosting and observability work. Freezing a surface that only serves ecosystem contributors would leave the commercial user's families to arrive post-1.0, where a namespace that was never designed for them has to absorb them additively — or force a 2.0
- [ ] **MCP protocol version pinned** — declare the minimum MCP spec version supported; document the upgrade path when MCP itself bumps
- [ ] **Resource URI scheme frozen** — `exeris://` URI shape is part of the contract
- [ ] **npm release** — `@exeris/ai-bridge@1.0.0` published to npm; signing + provenance attached
- [ ] **Docker image release** — `ghcr.io/exeris-systems/ai-bridge:1.0.0` published; multi-arch (amd64 + arm64)
- [ ] **Announcement** — blog post + landing-page mention; entry in `exeris-kernel-landin/` and `portfolio/` for ArkStack-side visibility
- [ ] **Sunset 0.x** — 0.x branch enters maintenance-only mode (security fixes 6 months)

---

## Versioning policy

- **0.x** — tool surface may change in any release; consumers re-pin per minor bump.
- **1.x** — tool surface stable. Additions are minor bumps. Schema-tightening (narrowing input types, removing optional fields from output) requires a major bump with one minor of deprecation warnings.
- **MCP spec compatibility** — the bridge tracks the latest stable MCP spec. When MCP bumps in a breaking way, the bridge ships a compat shim in a minor; full migration follows in the next major.

## Cross-repo dependencies

| Milestone | Dependency repo            | What it needs                                                                                                  |
|:----------|:----------------------------|:---------------------------------------------------------------------------------------------------------------|
| 0.3.0     | `exeris-platform`          | Three read-only custom LSP requests in `exeris-platform-lsp` (`exeris/domains`, `exeris/domainDescribe`, `exeris/actions`) — **shipped** (`feat/lsp-readonly-slice`); live data path verified end-to-end by the bridge integration test (default `exec:java` launch clean). 0.3.0 **closed** |
| 0.4.0     | `exeris-kernel`            | `KernelDiagnostics` SPI + Community provider + `exeris-kernel-diagnostics-cli` — **shipped** (v0.9.0, ADR-033). Cap-blind: no capability-composition surface. Bridge-side adapter + live data path verified end-to-end. 0.4.0 **closed** |
| 0.5.0     | `exeris-platform` (real), `exeris-kernel` (residual) | **Artifact-launchable LSP.** Both children are launched today as `mvn -f <ecosystemRoot>/…/pom.xml exec:java`, which requires the *source tree*; a P2 machine has none. **The kernel half is essentially satisfied**: `exeris-kernel-diagnostics-cli` is shaded (`maven-shade-plugin`, `Main-Class` in the manifest, main artifact replaced) and published by the root-reactor `mvn deploy`, so it runs as `java --enable-preview -jar <local-repo>/…jar`. Its residual ask is one line — add the module to `exeris-kernel-bom` `dependencyManagement`; at tag `v0.11.0` the BOM manages `spi` / `core` / `community` / `community-kafka` / `community-testkit` / `tck` and not the CLI, so it never arrives transitively even though an app developer does have the kernel in the local repo. *(Publication verified 2026-08-26: `eu.exeris.exeris-kernel-diagnostics-cli:0.11.0` is present in GitHub Packages, so the `continue-on-error: true` deploy step did carry it and `mvn dependency:get` is a real remedy.)* **The platform half is the real ask**: `exeris-platform-lsp` carries only `exec-maven-plugin` and produces a thin jar, so it needs a shaded/`jlink`ed launcher with `Main-Class: eu.exeris.platform.lsp.LspMain` — the diagnostics-CLI pom is the pattern to copy. Until that lands, `lsp:*` stays contributor-only |
| 0.6.0     | `exeris-sdk`               | **`annotation-catalog.json` as a published artifact** — annotation names, targets, retention, attributes with types/defaults, deprecation status + replacement. Generated by an SDK-side build step, not hand-maintained here. `AnnotationContractTest` already discovers every annotation by classpath reflection, so the emitter is that mechanism plus a serializer. Also: a published JSON Schema for `DomainMetadata` and the AST records |
| 0.7.0     | `exeris-tooling`           | **Stable diagnostic IDs in `ExerisDomainProcessor`.** Diagnostics are prefixed free text today — 9 `printMessage` sites behind a single `DIAG_PREFIX = "[Exeris] "` string, no code registry — so `build:explain_diagnostic` has a channel to key on but no stable identifiers. The kernel's `KernelErrorCodes` single-source-of-truth pattern is the obvious precedent. Without it, the tool degrades to fuzzy substring matching — shippable, but weak |
| 0.8.0     | `exeris-platform`          | **`exeris/previewMutation`** — a read-only sibling of `exeris/applyMutation` that applies a `MutationOp` in memory and returns the resulting diff + `MutationResult` **without touching disk**. `applyMutation` is declared at `ExerisProtocolExtensions.java:39` and has no preview counterpart yet; the `MutationOp` / `MutationResult` vocabulary such a method would carry is already established upstream by ADR-042 obligation 3 (`exeris-sdk`, ACCEPTED 2026-06-13; frozen at *its* 1.0.0, established now). Keeps the bridge literally read-only while making the idempotent write-back investment reachable by agents, not only by Studio. **Verified small**: in `MutationApplyService` the compute and the write are already separate — `applier.apply(…)` returns an `ApplyResult` carrying `applied()`, `source()` (the computed new source) and `outcome()`, and the *only* write is a single guarded `Files.writeString` plus the `onSourcesChanged` notify. Preview is that method minus that block, returning `outcome()` and the computed source. (The existing write-back error path already names "an ai-bridge consumer" in a comment — the seam was anticipated) |
| 0.9.0     | `exeris-docs`              | Stable file layout for ADRs, HLA, whitepaper, templates (no new requirement; just don't restructure the tree)   |
| 0.10.0    | none                       | (self-contained — SSE + Docker + k8s are local concerns)                                                       |

Every ask is small and well-shaped; none requires a new subsystem. After the 2026-08-26 reconciliation the critical path is **0.6.0 (annotation catalog)** — the content the whole `sdk:*` family serves, and the one ask with no upstream progress — followed by the **platform half of 0.5.0 (launchable LSP artifact)**, without which `lsp:*` stays contributor-only. The kernel half of 0.5.0 is effectively done upstream, and `caps:*` (0.7.0) turned out to have a shipped producer rather than a 2027 one.

**Upstream releases verified 2026-08-26** — `exeris-kernel` v0.11.0 (dev `0.12.0-SNAPSHOT`), `exeris-sdk` v0.10.0 (dev `0.11.0-SNAPSHOT`), `exeris-tooling` v0.7.0 (dev `0.8.0-SNAPSHOT`). This table drifted behind all three; re-verify the versions whenever a row is edited, because every ask below is stated against a moving upstream.

**Cite ADR obligation numbers, not upstream `ROADMAP.md` line numbers.** An ACCEPTED ADR does not move; a sibling repo's roadmap renumbers at every milestone, and a line reference that was right when written silently starts pointing at an unrelated item. Where an implementation has diverged from its own ADR's prose — it happens, and 0.8.0 above records two such cases — cite the obligation *and* say what the code actually does.

## Post-1.0 candidates (explicitly not scheduled)

- **`lsp:apply_mutation`** — direct canonical write-back into the user's project. Deliberately deferred past the preview cut: preview first buys real usage evidence about whether agents want the bridge to own the write at all, or are content to apply a canonical diff with their own file tools. Requires a further ADR-025 amendment redefining the cross-family read-only invariant, and would inherit `SourceDigest` / `BaselineTrust` for concurrency.
- **Project scaffolding** (`app:init`) — generate a new Exeris application skeleton. Overlaps a Maven archetype; decide which surface owns it before building either.
- **Enterprise-private extension** — per ADR-025 §"What is NOT in scope", ships as a separate `exeris-ai-bridge-enterprise` repo, never as a private overlay here.

## Tracking

- Per-milestone follow-ups: open issues with `milestone: 0.X.0` label on `github.com/exeris-systems/exeris-ai-bridge` (repo creation is the first 0.2.0 item).
- ADR amendments: any change to tool family scope, license, or process-boundary contract requires amending ADR-025 (or a successor ADR) before shipping.
- **Cross-repo asks are issued as companion issues in the owning repo**, referencing the milestone here. The 0.3.0 / 0.4.0 rows show the pattern: the bridge-side work lands independently, then binds when the companion ships.
