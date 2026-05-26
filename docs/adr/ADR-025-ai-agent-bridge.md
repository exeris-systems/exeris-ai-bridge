# ADR-025: AI Agent Bridge — MCP Server for Ecosystem Introspection

| Attribute       | Value                                                                                                                  |
|:----------------|:-----------------------------------------------------------------------------------------------------------------------|
| **Status**      | **ACCEPTED** (2026-05-15)                                                                                              |
| **Deciders**    | Arkadiusz Przychocki                                                                                                   |
| **Date**        | 2026-05-15                                                                                                             |
| **Scope**       | cross-repo                                                                                                             |
| **Owning Repo** | `exeris-ai-bridge`                                                                                                     |
| **Driven By**   | Recurrent demand for AI-agent assistance across the ecosystem; need to expose Studio/LSP, docs registry, and kernel introspection through a single, agent-native surface |
| **Compliance**  | [ADR-020](../../../exeris-docs/adr/ADR-020-open-core-documentation-mirror-policy.md) (visibility), [ADR-006](../../../exeris-docs/adr/ADR-006-spring-free-kernel-boundary.md) (The Wall) |

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
   - `lsp:*` — query Studio/LSP for `@ExerisDomain` types, action signatures, codegen artefacts. Talks to `exeris-platform-lsp` over JSON-RPC (LSP-native transport, no new wire format).
   - `docs:*` — search the ADR registry, fetch ADR-NNN content, fetch HLA / whitepaper / template by name. Reads `exeris-docs/` filesystem; no network dependency.
   - `kernel:*` — introspect provider registry, subsystem DAG, capability composition (per ADR-024). MUST NOT embed kernel; MUST query a running kernel via a *read-only diagnostic SPI* added to `exeris-kernel-spi`. Talks via a thin JSON-over-stdio adapter spawned by the agent (no Spring, no servlet, no IoC — see Wall obligation below).
3. **Stack: TypeScript.** Rationale: (a) `@modelcontextprotocol/sdk` is most mature in TS; (b) LSP bridge is naturally JSON-RPC in Node; (c) docs surface is filesystem-bound markdown — no Java needed; (d) kernel introspection crosses a process boundary by design (see The Wall obligation below), so language uniformity with the kernel is not a benefit. The kernel stays Java; the bridge stays TS; the boundary between them is JSON-over-stdio.
4. **The Wall is preserved (ADR-006).** `exeris-ai-bridge` is NOT on the kernel classpath. It is NOT a kernel provider. It is an external agent-facing tool that *queries* the kernel through a process boundary. The diagnostic SPI surface it consumes lives in `exeris-kernel-spi` and is read-only — `KernelDiagnostics` is a new SPI but it does not let the agent mutate kernel state. Provider implementations of that SPI ship in Community.
5. **Not a capability (ADR-023, ADR-024).** `exeris-ai-bridge` is not a Tier 2 `exeris-caps-*` repository. It does not declare `@Provides` / `@Requires`. It does not enter a composition. It is a developer-facing tool, structurally closer to `exeris-tooling` than to a capability.
6. **License.** Apache 2.0 — consistent with `exeris-kernel`, `exeris-sdk`, `exeris-tooling`. Agent tooling should be maximally permissive to encourage adoption by third-party agents and IDE plugins; commercial protection of the ecosystem is enforced at the capability and SKU layer per ADR-023, not at the agent-bridge layer.
7. **Cross-repo link stubs.** Per ADR-020 §2, `exeris-kernel/docs/adr/ADR-025.link.md` and `exeris-platform/docs/adr/ADR-025.link.md` are mandatory. `exeris-ai-bridge/docs/adr/` holds the authoritative copy of this file.
8. **Sub-repo map update.** `~/exeris-systems/CLAUDE.md` sub-repo map gains a row for `exeris-ai-bridge` with stack `TypeScript / Node 20+, npm` and `Has CLAUDE.md? ✅`. The routing section gains a `AI-agent integration, MCP, agent tooling → exeris-ai-bridge/` entry.

## Consequences

### ✅ Positive Outcomes

- **[+] Agents pay context cost once.** Instead of every session re-deriving ADR rules, three-tier architecture, and codegen pipeline by grepping markdown, the agent calls `docs:get_adr 024` or `kernel:list_capabilities` and gets the structured answer.
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

## Cross-references

- ADR-006 (Spring-Free Kernel Boundary) — the bridge MUST NOT bring Spring into the kernel; the boundary is by-design satisfied because the bridge is a separate process in a separate language.
- ADR-018 (Observability Tooling Repo Split) — precedent for the cross-repo `.link.md` stub pattern this ADR uses.
- ADR-020 (Open-Core Documentation Boundary & Cross-Repo Mirror Policy) — visibility model; this ADR is `public`.
- ADR-023 (Capability Licensing Taxonomy) — the bridge is NOT a capability; this ADR confirms that explicitly.
- ADR-024 (Capability Composition Model) — the `kernel:list_capabilities` tool surfaces composition output; the bridge consumes the model, does not extend it.
- [Model Context Protocol specification](https://spec.modelcontextprotocol.io/) — the wire protocol this repo implements.
- `exeris-platform/exeris-platform-lsp/` — the LSP server this bridge proxies for the `lsp:*` tool family.

## Engineering Protocol

Once accepted:

1. **`exeris-ai-bridge/` scaffold lands** (this ADR is the lock-in event). Initial commit includes `package.json`, `tsconfig.json`, MCP server entry, the three tool family placeholders, README, LICENSE (Apache 2.0), and per-repo CLAUDE.md. Tool implementations follow in subsequent PRs.
2. **`KernelDiagnostics` SPI RFC lands in `exeris-kernel/docs/rfc/`** before any `kernel:*` tool is wired to a real kernel. The RFC must show the read-only surface, the stability contract, and the JSON-over-stdio adapter shape.
3. **`exeris-kernel/docs/adr/ADR-025.link.md` and `exeris-platform/docs/adr/ADR-025.link.md` stubs land** alongside or before this ADR moves from PROPOSED to ACCEPTED.
4. **`~/exeris-systems/CLAUDE.md` sub-repo map updated** alongside or before this ADR moves from PROPOSED to ACCEPTED.
5. **Accepted on the day of authoring (2026-05-15)** — single-author decision; the registry's "don't ship in PROPOSED for long" discipline collapses to same-day accept here. The `KernelDiagnostics` RFC remains a follow-up (item 2 above) and gates the `kernel:*` tool family only; the `docs:*` and `lsp:*` families ship independently.
