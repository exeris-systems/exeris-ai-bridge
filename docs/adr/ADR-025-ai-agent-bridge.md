# ADR-025: AI Agent Bridge — MCP Server for Ecosystem Introspection

| Attribute       | Value                                                                                                                  |
|:----------------|:-----------------------------------------------------------------------------------------------------------------------|
| **Status**      | **ACCEPTED** (2026-05-15)                                                                                              |
| **Deciders**    | Arkadiusz Przychocki                                                                                                   |
| **Date**        | 2026-05-15                                                                                                             |
| **Scope**       | cross-repo                                                                                                             |
| **Owning Repo** | `exeris-ai-bridge`                                                                                                     |
| **Driven By**   | Recurrent demand for AI-agent assistance across the ecosystem; need to expose Studio/LSP, docs registry, and kernel introspection through a single, agent-native surface |
| **Compliance**  | [ADR-020](https://github.com/exeris-systems/exeris-docs/blob/main/adr/ADR-020-open-core-documentation-mirror-policy.md) (visibility), [ADR-006](https://github.com/exeris-systems/exeris-docs/blob/main/adr/ADR-006-spring-free-kernel-boundary.md) (The Wall) |

## Context and Problem Statement

The Exeris ecosystem already exposes rich semantic surfaces to humans: the LSP server in `exeris-platform`, the ADR registry and high-level architecture in `exeris-docs`, and the kernel SPI/Core/Community contracts in `exeris-kernel`. AI agents (Claude Code, Cursor, Copilot Workspace, and others) operating against this codebase today must rediscover all of this surface by reading files, grepping conventions, and re-deriving rules that are already formally stated.

This is a measurable cost: every agent session re-pays the same context-discovery overhead before doing useful work, and worse, agents routinely violate ecosystem-wide rules (The Wall, three-tier architecture, ADR numbering discipline) because those rules live in markdown that the agent loads lazily, not in a queryable interface. The kernel's `@ExerisDomain` source model and the LSP's compile-time index are both *already* structured — they are simply not addressable by agent tooling.

The Model Context Protocol (MCP) is the emerging standard for exposing tools and resources to AI agents in a vendor-neutral way. An MCP server living in the Exeris monorepo neighborhood could publish three classes of surface — Studio/LSP bridge, docs/ADR registry, kernel introspection — through a single agent-native protocol, replacing today's "grep and pray" with a queryable contract.

**This ADR answers: where does that surface live, and what is its mission scope?**

## 🏁 The Decision

**Create a new public sibling repository `exeris-ai-bridge` whose mission is to expose Exeris ecosystem surfaces (Studio/LSP, docs/ADR registry, kernel introspection) to AI agents via the Model Context Protocol, with room to host adjacent AI-integration artefacts (Claude Skills, agent SDK adapters) as they emerge.**

The repo is deliberately named *bridge*, not *mcp*: MCP is the first protocol surface, not the mission. Future integrations (e.g. agent-SDK adapters, Claude Skills bundles consumed by the ecosystem, future protocols) live in this same repo when they share the same fundamental responsibility: bridging Exeris semantic surfaces to AI agents.

### Concrete obligations

1. **Repository and layout.** `~/exeris-systems/exeris-ai-bridge/` — public, Apache 2.0, top-level sibling to `exeris-kernel`, `exeris-sdk`, `exeris-tooling`. TypeScript + Node 20+ as the implementation stack (rationale below). Module layout: `src/tools/lsp/`, `src/tools/docs/`, `src/tools/kernel/` for the three initial tool families; `src/server.ts` for the MCP server entry; `src/transport/` for stdio and SSE transports.
2. **Three initial tool families.**
   - `lsp:*` — query Studio/LSP for `@ExerisDomain` types, action signatures, codegen artefacts. Talks to `exeris-platform-lsp` over JSON-RPC (LSP-native transport, no new wire format). *(The concrete method names + payload shapes are pinned by the 2026-06-24 amendment "`lsp:*` Binds to the Read-Only `exeris/*` LSP Slice" below: methods are `exeris/domains` / `exeris/domainDescribe` / `exeris/actions`, read-only.)*
   - `docs:*` — search the ADR registry, fetch ADR-NNN content, fetch HLA / whitepaper / template by name. Reads `exeris-docs/` filesystem; no network dependency.
   - `kernel:*` — introspect provider registry, subsystem DAG, per-subsystem detail, JVM/runtime ergonomics. MUST NOT embed kernel; MUST query a running kernel via a *read-only diagnostic SPI* (`KernelDiagnostics`) in `exeris-kernel-spi`. Talks via a thin JSON-over-stdio adapter spawned by the agent (no Spring, no servlet, no IoC — see Wall obligation below). *(The original wording listed "capability composition (per ADR-024)" here — **superseded by the 2026-06-17 amendment "`kernel:*` Is Cap-Blind" below**. ADR-024's 2026-06-17 "Validation Stamp Lifecycle" amendment makes the open kernel cap-blind, so capability composition is NOT a `kernel:*` surface; it is a tooling/platform concern. The provider-registry / subsystem-DAG clauses stand.)*
3. **Stack: TypeScript.** Rationale: (a) `@modelcontextprotocol/sdk` is most mature in TS; (b) LSP bridge is naturally JSON-RPC in Node; (c) docs surface is filesystem-bound markdown — no Java needed; (d) kernel introspection crosses a process boundary by design (see The Wall obligation below), so language uniformity with the kernel is not a benefit. The kernel stays Java; the bridge stays TS; the boundary between them is JSON-over-stdio.
4. **The Wall is preserved (ADR-006).** `exeris-ai-bridge` is NOT on the kernel classpath. It is NOT a kernel provider. It is an external agent-facing tool that *queries* the kernel through a process boundary. The diagnostic SPI surface it consumes lives in `exeris-kernel-spi` and is read-only — `KernelDiagnostics` is a new SPI but it does not let the agent mutate kernel state. Provider implementations of that SPI ship in Community.
5. **Not a capability (ADR-023, ADR-024).** `exeris-ai-bridge` is not a Tier 2 `exeris-caps-*` repository. It does not declare `@Provides` / `@Requires`. It does not enter a composition. It is a developer-facing tool, structurally closer to `exeris-tooling` than to a capability.
6. **License.** Apache 2.0 — consistent with `exeris-kernel`, `exeris-sdk`, `exeris-tooling`. Agent tooling should be maximally permissive to encourage adoption by third-party agents and IDE plugins; commercial protection of the ecosystem is enforced at the capability and SKU layer per ADR-023, not at the agent-bridge layer.
7. **Cross-repo link stubs.** Per ADR-020 §2, `exeris-kernel/docs/adr/ADR-025.link.md` and `exeris-platform/docs/adr/ADR-025.link.md` are mandatory. `exeris-ai-bridge/docs/adr/` holds the authoritative copy of this file.
8. **Sub-repo map update.** `~/exeris-systems/CLAUDE.md` sub-repo map gains a row for `exeris-ai-bridge` with stack `TypeScript / Node 20+, npm` and `Has CLAUDE.md? ✅`. The routing section gains a `AI-agent integration, MCP, agent tooling → exeris-ai-bridge/` entry.

## Consequences

### ✅ Positive Outcomes

- **[+] Agents pay context cost once.** Instead of every session re-deriving ADR rules, three-tier architecture, and codegen pipeline by grepping markdown, the agent calls `docs:get_adr 024` or `kernel:get_bootstrap_dag` and gets the structured answer.
- **[+] Single MCP endpoint for the ecosystem.** External agent users (customers building on Exeris, internal contributors, IDE extensions) point at one MCP server instead of integrating three separate surfaces ad hoc.
- **[+] LSP investment compounds.** The `exeris-platform-lsp` semantic index — already built for Studio — gets a second consumer (agents) without re-implementation.
- **[+] Wall stays intact.** Because the bridge is a separate repo and a separate process, there is zero risk of the AI surface accidentally importing into the kernel classpath. The boundary is enforced by language and process, not just by package convention.
- **[+] Open-core narrative gets stronger.** A public, Apache 2.0 MCP server for the kernel is a marketing artefact: prospective adopters can demo "tell Claude about my Exeris setup" before they buy commercial capabilities.

### ⚠️ Trade-offs

- **[-] Twentieth sibling repo.** Repo count grows from ~19 to 20 active siblings. The routing CLAUDE.md and HLA must add this repo; sub-repo discovery cost rises marginally for new contributors. Acceptable — naming and the new routing row mitigate.
- **[-] Cross-process kernel introspection is more work than in-process.** A `KernelDiagnostics` SPI plus a JSON-over-stdio adapter is more wiring than just adding a Java library would have been. We accept this cost because the alternative (linking the agent bridge into the kernel JVM) violates The Wall and ties agent-tooling cadence to kernel release cadence.
- **[-] New JS toolchain in the ecosystem.** `exeris-tooling/exeris-codegen-ts` already uses Node, so this is not net-new, but the agent bridge is the first repo whose *primary* artefact is published to npm. We will need npm publishing credentials in CI and an `@exeris/ai-bridge` package scope.
- **[-] Read-only diagnostic SPI is non-trivial to design.** Exposing provider registry and subsystem state without leaking implementation detail is its own contract design problem. This ADR commits to *creating* `KernelDiagnostics`, not to its full shape; that shape will be designed in a follow-up RFC inside `exeris-kernel/docs/rfc/` before any provider implementation ships.

### 📋 What is NOT in scope

- **Authoring agent-facing prompts, skills, or persona configurations.** Skill bundles (e.g. `exeris-architect-guardrails`) currently live next to the code they review (`exeris-kernel/.claude/skills/`) and SHOULD stay there. The bridge exposes *data*; agents bring their own *behavior*.
- **Replacing Studio.** Studio (`exeris-platform`) is a human-facing IDE/UX. The bridge is an agent-facing protocol. They consume the same LSP index but serve different surfaces.
- **Embedding LLMs.** `exeris-ai-bridge` does NOT call out to any model provider. It is the *server* side of MCP — the agent (Claude, Cursor, etc.) is the client and the LLM lives there. No model API keys live in this repo.
- **A capability or SKU.** This repo is not part of the Tier 1 substrate, the Tier 2 capability ecosystem, or the Tier 3 SKU layer (per HLA §§2.2, 3, 4). It is developer-facing tooling.
- **Enterprise-private surface.** This first cut is fully public. An enterprise-private extension (e.g. exposing crash-decoder diagnostics from `exeris-enterprise-observability`) is conceivable but explicitly deferred — when needed, it ships as a separate `exeris-ai-bridge-enterprise` repo per the ADR-020 / ADR-018 split pattern, NOT as a private overlay in this public repo.

## `kernel:*` Is Cap-Blind — Capability Composition Is a Tooling/Platform Surface (2026-06-17 amendment)

The body of this ADR assigned **capability composition** introspection to the `kernel:*` tool family: obligation 2's `kernel:*` bullet ("introspect provider registry, subsystem DAG, capability composition (per ADR-024)"), the `kernel:list_capabilities` example in Consequences, and the ADR-024 cross-reference all located the composition graph behind a `KernelDiagnostics`-sourced kernel tool. ADR-024's 2026-06-17 "Validation Stamp Lifecycle" amendment makes that placement wrong; this amendment realigns the bridge to it.

### Why the kernel cannot be the source

ADR-024 (revised obligation 9) makes the open kernel **cap-blind**: "No kernel package gains a stamp check, a manifest reader, or any capability/composition type." Capability composition is a **build-time** artefact — `exeris-tooling` resolves the `@Provides`/`@Requires` DAG and emits `cap-manifest.json` + validation stamp + content binding; the `exeris-platform` composition runtime asserts it at SKU startup. By the time a kernel is running, the composition is already resolved and **erased** into providers and bootstrap subsystems; the kernel models neither caps nor compositions.

A kernel-sourced `list_capabilities` therefore cannot return real composition data — it can only re-project the kernel's own subsystems as pseudo-capabilities. (At the time of this amendment the shipped `KernelDiagnostics.listCapabilities()` does exactly that: each bootstrap subsystem becomes a `CapabilityDescriptor` whose sole `@Provides` is its own name — the same data `getBootstrapDag()` returns, wearing capability vocabulary.) That is a Tier-2 concept leaking into a Tier-1 surface and a false promise to agents; the Wall (ADR-006) and ADR-024's cap-blind kernel both forbid it.

### The Decision

1. **`kernel:*` is corrected to read-only *runtime* introspection only** — provider registry, bootstrap/subsystem DAG, per-subsystem detail, and JVM/runtime ergonomics: all genuine Tier-1 kernel state exposed by `KernelDiagnostics`. The family does **not** surface capability composition.
2. **`kernel:list_capabilities` is removed** from the tool surface and the ROADMAP. The remaining `kernel:*` tools are `kernel:list_providers`, `kernel:get_bootstrap_dag`, and `kernel:describe_subsystem` (plus runtime ergonomics if/when surfaced).
3. **The kernel-side removal of `KernelDiagnostics.listCapabilities()` / `CompositionSnapshot` / `CapabilityDescriptor` is an ADR-033 concern** owned by `exeris-kernel`. This amendment records the bridge-side correction and the dependency; the ADR-033 revision is handled in that repo.
4. **Capability-composition introspection, if the bridge ever exposes it, sources from the build-time composition artefacts** (`exeris-tooling` `cap-manifest.json` + signed composition manifest) and/or the `exeris-platform` composition runtime — **never** the kernel. It is **deferred**: no `exeris-caps-*` repository exists yet (ADR-024 targets the first cap in H1 2027). When it lands it requires its **own** ADR-025 amendment naming the family and pinning its source; it must not be bolted onto `kernel:*` and must not be created unilaterally (per this repo's tool-family discipline and CLAUDE.md).

### Cross-references for this amendment

- ADR-024 (Capability Composition Model — 2026-06-17 "Validation Stamp Lifecycle" amendment, revised obligation 9) — the cap-blind-kernel decision this amendment aligns to.
- ADR-006 (The Wall) — Tier 1 stays blind to Tier 2 abstractions.
- ADR-033 (`KernelDiagnostics` SPI, owned by `exeris-kernel`) — the SPI whose `listCapabilities()` method is removed in lockstep; tracked in that repo.

## `lsp:*` Binds to the Read-Only `exeris/*` LSP Slice (2026-06-24 amendment)

Obligation 2's `lsp:*` bullet committed the family to "query Studio/LSP … over JSON-RPC (LSP-native transport, no new wire format)" but did not pin the method names or payload shapes — at acceptance `exeris-platform-lsp` was a skeleton. The companion read-only slice has now landed (`exeris-platform`, `feat/lsp-readonly-slice`), so this amendment pins the contract the bridge consumes.

### The Decision

1. **Method namespace is `exeris/*`, not `workspace/exeris*`.** The three custom requests are `exeris/domains`, `exeris/domainDescribe` (params `{ qualifiedName }`), and `exeris/actions`. They map onto the bridge tools `lsp:list_domains`, `lsp:describe_domain`, and `lsp:list_actions` respectively. (The earlier `workspace/exeris*` working names from ROADMAP 0.3.0 are superseded.)
2. **The wire shapes are fixed and validated bridge-side.** `exeris/domains` → `DomainSummary[]` (`qualifiedName`, `simpleName`, `packageName`, `sourcePath`); `exeris/domainDescribe` → `DomainDescription` (the summary fields plus `fields[]` of `{ name, type, required }`, `actions[]` of `{ name, httpMethod, resultType, params[] }`, and `artefacts[]` — generated surfaces such as `rest` / `graphql` / `realtime` / `eventSourced` / `saga` / `events` / `internalClient`); `exeris/actions` → `ActionSummary[]` (`owningDomain`, `name`, `httpMethod`, `resultType`, `params[]`). The bridge validates each result against these shapes (`src/tools/lsp/shapes.ts`) and re-emits only the contract fields, so a version-skewed server surfaces a clear shape error instead of leaking drift to the agent.
3. **The slice is read-only — by design and by construction.** Per the platform method-surface contract the `exeris/*` namespace also reserves a write-back method (`exeris/applyMutation`); the bridge **does not** consume it and MUST NOT. This is the `lsp:*` analogue of hard constraint 3 (no mutation of kernel state): the bridge is a read-only introspection surface across **all** families, not only `kernel:*`.

### Cross-references for this amendment

- ADR-006 (The Wall) — the bridge proxies the LSP over a process boundary; no Java interop.
- `exeris-platform/exeris-platform-lsp/` (`feat/lsp-readonly-slice`) — the companion that defines `ExerisProtocolExtensions` + `ProtocolProjections`; the authoritative source of these wire shapes.

## `kernel:*` Binds to the `KernelDiagnostics` NDJSON Contract (2026-06-25 amendment)

Obligation 2's `kernel:*` bullet committed the family to "query a running kernel via a read-only diagnostic SPI (`KernelDiagnostics`) … via a thin JSON-over-stdio adapter" but, at acceptance, the SPI and CLI were not yet shipped. They have now landed (`exeris-kernel` v0.9.0, ADR-033), so this amendment pins the contract the bridge consumes — the `kernel:*` analogue of the `lsp:*` binding amendment above.

### The Decision

1. **Transport is NDJSON over stdio to a child `exeris-kernel-diagnostics-cli`.** One JSON request line in, one response line out, in receipt order, with **no id field** — the protocol is stateless and the bridge correlates responses **FIFO** (`src/transport/kernel-adapter.ts`, framing in `src/transport/ndjson-framing.ts`). Launch spec is `EXERIS_KERNEL_COMMAND` (operator-supplied, never agent-supplied; the path-sandbox does not apply, exactly as for `EXERIS_LSP_COMMAND`).
2. **The three methods are `listProviders`, `getBootstrapDag`, and `describeSubsystem`** (params `{ name }`), mapping onto `kernel:list_providers`, `kernel:get_bootstrap_dag`, and `kernel:describe_subsystem`. The wire shapes are fixed and validated bridge-side (`src/tools/kernel/shapes.ts`, mirrored 1:1 from `eu.exeris.kernel.spi.diagnostics.*`, `schemaVersion` "1.0"): `ProvidersSnapshot` (`providers[]` of `{ providerName, spiType, priority, displayName }`, `displayName` nullable), `BootstrapDagSnapshot` (`nodes[]` of `{ name, phase, dependsOn[], running, optional }`), `SubsystemSnapshot` (`requestedName`, nullable `subsystem`). A version-skewed CLI surfaces a clear shape error, not drift. The CLI also exposes `getJvmErgonomics`; the bridge does **not** surface it yet — adding a `kernel:*` runtime-ergonomics tool is a future scoped change, not a contract gap.
3. **Read-only and cap-blind — by design and by construction.** The SPI is read-only and the bridge sends no mutating request (hard constraint 3). `listProviders` enumerates one Community provider per SPI domain; it is **not** a capability-composition surface, consistent with the 2026-06-17 "`kernel:*` Is Cap-Blind" amendment. No `kernel:list_capabilities`.

### Cross-references for this amendment

- ADR-006 (The Wall) — the bridge reaches the kernel only through a child process over NDJSON; no Java interop, no embedded kernel.
- ADR-033 / `exeris-kernel` (v0.9.0) — `KernelDiagnostics` SPI + Community provider + `exeris-kernel-diagnostics-cli`; the authoritative source of these snapshot shapes and the `schemaVersion` "1.0" stability contract.
- The 2026-06-17 "`kernel:*` Is Cap-Blind" amendment above — the cap-blind stance this binding upholds.

## Two Personas — The Bridge Serves Application Developers, Not Only Ecosystem Contributors (2026-08-16 amendment)

The body of this ADR scopes the mission as "**ecosystem** introspection": obligation 2's three families are each sourced from an ecosystem-internal artefact — `docs:*` from the ADR registry of Exeris' own decisions, `lsp:*` from the Studio index, `kernel:*` from a running kernel. That framing was right for the first four milestones and is incomplete for the next four. This amendment names the second audience the bridge was always going to need, and authorises the surfaces that serve it.

### The gap, as evidenced

The bridge has one implicit user: someone working **on** Exeris, with all sibling repositories checked out. The developer building a product **on** Exeris — the commercial adopter — is served by nothing. Three pieces of evidence, none of them a matter of taste:

1. **Configuration makes the second persona impossible, not merely inconvenient.** `loadConfig()` resolves `EXERIS_DOCS_ROOT ?? ../exeris-docs` through a fail-fast existence check and derives `ecosystemRoot = dirname(docsRoot)`, from which the default LSP and kernel-CLI launch specs are built as `mvn -f <ecosystemRoot>/…/pom.xml exec:java`. An application developer has a Maven dependency on `eu.exeris:*` and their own sources — no such tree. **The server does not boot.**
2. **The planned prompt surface was entirely single-persona.** ROADMAP 0.5.0 listed `review-three-tier-violations`, `draft-adr`, `route-this-task`, `wall-audit`. Four contributor workflows; zero entity-authoring workflows.
3. **The authoring surfaces exist upstream and are unreachable.** `exeris-sdk` publishes 49 annotations (33 root, 10 `system`, 4 `capability`, 2 `security`) whose canonical `@Field` / `@Validation` scoping is stated in two `package-info.java` files; `exeris-tooling` emits `DomainMetadata`, `cap-manifest.json`, and processor diagnostics; `MutationOp` defines nine entity-authoring operations with `SourceDigest` / `BaselineTrust` concurrency, applied idempotently by `exeris/applyMutation`. An agent helping an application developer today rediscovers all of it by grep — precisely the cost this ADR's Context section was written to eliminate, re-incurred one layer up.

### The Decision

1. **Two named personas, co-equal through 1.0.** **P1 — ecosystem contributor** (works on Exeris; has the sibling checkout; served by `docs:*` / `kernel:*` / `lsp:*`). **P2 — application developer** (builds on Exeris; has no ecosystem checkout; served by the families below). The mission sentence in The Decision above is read accordingly: the bridge exposes Exeris **semantic** surfaces to agents — ecosystem introspection is the first class of those surfaces, not the whole set.

2. **Zero-checkout is a first-class operating mode.** The bridge MUST boot and serve on a machine with no ecosystem repository present. Concretely: a missing root disables its family with a structured error rather than throwing out of config load; `ecosystemRoot` becomes optional rather than load-bearing; the P2 reference corpus (annotation catalog, AST schema, authoring guides) ships inside the npm package, generated at release time from released upstream artifacts; and the LSP and diagnostics-CLI children become launchable from published artifacts, not only from a source tree. Contributor mode remains, selected by `EXERIS_BRIDGE_MODE`.

3. **Three new tool families are authorised, with sources pinned.**
   - **`sdk:*`** — annotation catalog, attribute contracts, `@Field`/`@Validation` canonical scoping, deprecation pipeline, AST/JSON-Schema shapes. Source: **released `exeris-sdk` artifacts**, vendored into the package at release. Read-only.
   - **`build:*`** — the user's own project: emitted `DomainMetadata`, which artefacts codegen will produce, L1/L2 detach state, decoded processor diagnostics. Source: **the user's project filesystem**, under a pinned project root with the same sandbox discipline as `docs:*`. Read-only.
   - **`caps:*`** — `cap-manifest.json` (schema v2) and its `CompositionStamp`. Source: **build-time artefacts emitted by `exeris-tooling`**. Read-only, and it reads manifests only — it does **not** re-resolve the `@Requires`→`@Provides` DAG, which is tooling's job.

   **`caps:*` is the family the 2026-06-17 amendment pre-authorised.** That amendment permitted a future composition surface on two conditions: that it source from build-time artefacts and/or the platform composition runtime and **never** from the kernel, and that it arrive through "its own ADR-025 amendment naming the family and pinning its source". This clause is that amendment. `kernel:*` remains cap-blind; there is still no `kernel:list_capabilities`.

4. **The cross-family read-only invariant stands. The bridge previews; it does not write.** The 2026-06-24 amendment established that the bridge is read-only across *all* families and MUST NOT consume `exeris/applyMutation`. That holds unchanged. To make canonical edits reachable without breaching it, the bridge consumes a **new, read-only** `exeris/previewMutation`: a `MutationOp` is applied **in memory** platform-side and the resulting diff plus `MutationResult` is returned; **nothing is written to disk by anyone but the agent's own file tools.** No tool handler may write into the user's project — enforced by test, not by review. Direct write-back (`lsp:apply_mutation`) is deliberately **deferred**: it would redefine this invariant and therefore requires a further amendment, taken with usage evidence from the preview cut in hand rather than in advance.

5. **Sequencing: the P2 track lands before 1.0, ahead of hosting and observability.** 1.0 GA freezes the tool surface. Freezing a surface that serves only P1 would push the commercial adopter's families past the freeze, where a namespace never designed for them must absorb them additively — or force a 2.0. The ROADMAP renumbers accordingly (P2 track at 0.5.0–0.8.0; resources/prompts, SSE, observability, security, polish shift to 0.9.0–0.13.0).

6. **Cross-repo obligations.** Each is a companion ask in the owning repo, tracked in the ROADMAP's cross-repo table: **`exeris-platform`** — artifact-launchable LSP (0.5.0) and `exeris/previewMutation` (0.8.0); **`exeris-kernel`** — artifact-launchable diagnostics CLI (0.5.0); **`exeris-sdk`** — `annotation-catalog.json` plus a published AST JSON Schema, generated by the reflection mechanism `AnnotationContractTest` already uses (0.6.0); **`exeris-tooling`** — stable diagnostic IDs in `ExerisDomainProcessor`, which emits free text today (0.7.0).

### What this amendment does NOT change

- **The Wall (obligation 4).** Every new family is filesystem-bound or crosses the existing process boundary. No Java interop, no kernel classpath, no embedded kernel.
- **No model API calls** (§"What is NOT in scope" → "Embedding LLMs"; CLAUDE.md hard constraint 2). Unchanged.
- **Not a capability (obligation 5).** `caps:*` *reads about* capabilities; it does not make the bridge one. No `@Provides` / `@Requires`, no composition membership.
- **Cap-blind kernel.** `kernel:*` gains nothing here. Composition data comes from build-time artefacts exclusively.
- **License (obligation 6).** Apache 2.0.

### Cross-references for this amendment

- The 2026-06-17 "`kernel:*` Is Cap-Blind" amendment above — whose deferred-composition clause this amendment satisfies for `caps:*`.
- The 2026-06-24 "`lsp:*` Binds to the Read-Only `exeris/*` LSP Slice" amendment above — whose read-only invariant the preview-not-write stance upholds.
- ADR-024 (Capability Composition Model) — composition is a build-time artefact; `caps:*` reads its output and re-derives nothing.
- ADR-003 (Entity-First Development Strategy, `exeris-sdk`) — the premise the `sdk:*` and `build:*` families serve: the annotated Java class is the single source of truth, so agent assistance belongs at the annotation and codegen layer.

## Cross-references

- ADR-006 (Spring-Free Kernel Boundary) — the bridge MUST NOT bring Spring into the kernel; the boundary is by-design satisfied because the bridge is a separate process in a separate language.
- ADR-018 (Observability Tooling Repo Split) — precedent for the cross-repo `.link.md` stub pattern this ADR uses.
- ADR-020 (Open-Core Documentation Boundary & Cross-Repo Mirror Policy) — visibility model; this ADR is `public`.
- ADR-023 (Capability Licensing Taxonomy) — the bridge is NOT a capability; this ADR confirms that explicitly.
- ADR-024 (Capability Composition Model, incl. the 2026-06-17 "Validation Stamp Lifecycle" amendment) — the open kernel is **cap-blind**: capability composition is emitted by `exeris-tooling` (build-time `cap-manifest.json` + validation stamp + content binding) and asserted by the `exeris-platform` composition runtime, never by the kernel. The bridge therefore does **not** surface capability composition through `kernel:*`; see the 2026-06-17 amendment below.
- [Model Context Protocol specification](https://spec.modelcontextprotocol.io/) — the wire protocol this repo implements.
- `exeris-platform/exeris-platform-lsp/` — the LSP server this bridge proxies for the `lsp:*` tool family.

## Engineering Protocol

Once accepted:

1. **`exeris-ai-bridge/` scaffold lands** (this ADR is the lock-in event). Initial commit includes `package.json`, `tsconfig.json`, MCP server entry, the three tool family placeholders, README, LICENSE (Apache 2.0), and per-repo CLAUDE.md. Tool implementations follow in subsequent PRs.
2. **`KernelDiagnostics` SPI RFC lands in `exeris-kernel/docs/rfc/`** before any `kernel:*` tool is wired to a real kernel. The RFC must show the read-only surface, the stability contract, and the JSON-over-stdio adapter shape.
3. **`exeris-kernel/docs/adr/ADR-025.link.md` and `exeris-platform/docs/adr/ADR-025.link.md` stubs land** alongside or before this ADR moves from PROPOSED to ACCEPTED.
4. **`~/exeris-systems/CLAUDE.md` sub-repo map updated** alongside or before this ADR moves from PROPOSED to ACCEPTED.
5. **Accepted on the day of authoring (2026-05-15)** — single-author decision; the registry's "don't ship in PROPOSED for long" discipline collapses to same-day accept here. The `KernelDiagnostics` RFC remains a follow-up (item 2 above) and gates the `kernel:*` tool family only; the `docs:*` and `lsp:*` families ship independently.
