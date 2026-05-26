# Exeris AI Bridge — Roadmap to 1.0.0 GA

The bridge is the **agent-facing surface** of the Exeris ecosystem: an MCP server that exposes three semantic surfaces — `docs:*` (ADR registry, HLA, whitepaper), `lsp:*` (Studio/LSP semantic index), `kernel:*` (read-only kernel introspection via `KernelDiagnostics`) — to AI agents over stdio (and later SSE).

**1.0.0 GA means: the MCP tool surface is stable.** Tool names, input schemas, and output shapes are frozen under semver. Third-party agents and IDE extensions can pin to a `@exeris/ai-bridge@^1` and trust that a 1.x bump will not break their prompts or tool-call wiring.

Founding decision: [ADR-025 — AI Agent Bridge / MCP Server for Ecosystem Introspection](docs/adr/ADR-025-ai-agent-bridge.md).

This file tracks scope per milestone. Items marked `[ ]` are open; `[x]` shipped.

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

## 0.2.0 — `docs:*` family + CI + first agent demo

> Goal: a running Claude Code session can call `docs:list_adrs` and `docs:get_adr 024` against this server and get correct answers from `../exeris-docs/`. Everything is filesystem-bound; zero external process dependencies.

- [ ] **`git init` + first commit** in `exeris-ai-bridge/`; push to `github.com/exeris-systems/exeris-ai-bridge` (public repo creation)
- [ ] **CI** — `.github/workflows/build.yml`: `npm ci` → `npm run typecheck` → `npm run build` → `npm test` on Node 20 and 22
- [ ] **`docs:list_adrs`** — parses `../exeris-docs/adr-index.md` markdown table, returns `{ number, title, owningRepo, scope, visibility, status, link }[]`; supports optional `status` filter
- [ ] **`docs:get_adr`** — resolves ADR-NNN by number against the index, reads the authoritative file (handles cross-repo paths), returns full markdown body
- [ ] **`docs:get_template`** — fetches `templates/{ADR,RFC,RESEARCH}-TEMPLATE.md` by name
- [ ] **`docs:get_hla`** + **`docs:get_whitepaper`** — return canonical narrative docs
- [ ] **`docs:search`** — ripgrep-equivalent over `../exeris-docs/` with bounded result count and path filters
- [ ] **Path-sandbox guard** — every filesystem read resolves under a configured root and rejects paths that escape it (path-traversal hardening from day 1)
- [ ] **`EXERIS_DOCS_ROOT` env var** — points at the `exeris-docs/` checkout; sensible default for the monorepo-neighbour layout (`../exeris-docs` relative to the bridge install)
- [ ] **Unit tests** for every tool handler (parsing, filtering, sandbox enforcement) using `node --test`
- [ ] **First end-to-end demo** — `.claude/settings.json` config snippet committed to README; manual smoke: open Claude Code, ask "list all ADR-024-related context" and confirm the server returns it
- [ ] **npm publish dry-run** — `@exeris/ai-bridge@0.2.0` resolves, `npm pack` output reviewed

## 0.3.0 — `lsp:*` family

> Goal: the bridge proxies `exeris-platform-lsp` over JSON-RPC. Agents can ask the bridge about `@ExerisDomain` types and get answers grounded in the same semantic index Studio uses.

- [ ] **LSP transport layer** — `src/transport/lsp-client.ts`: JSON-RPC client over stdio against a child `exeris-platform-lsp` process
- [ ] **LSP server discovery** — `EXERIS_LSP_COMMAND` env var (default: `mvn -f ../exeris-platform/exeris-platform-lsp/pom.xml exec:java`); lazy spawn on first `lsp:*` call; cached handle
- [ ] **`lsp:list_domains`** — `workspace/exerisDomains` custom request (to be added to `exeris-platform-lsp`); returns `{ qualifiedName, simpleName, packageName, sourcePath }[]`
- [ ] **`lsp:describe_domain`** — `workspace/exerisDomainDescribe` custom request; returns field list, action signatures, generated artefact references
- [ ] **`lsp:list_actions`** — list of all `@Action` methods across the workspace
- [ ] **Resilience** — LSP not running / crashed / wrong version → tool returns structured error (not crash); `bridge:health` (added in 0.7) surfaces the failure mode
- [ ] **Cross-repo coordination** — companion PR in `exeris-platform/exeris-platform-lsp/` adding the three custom LSP requests; cited in this milestone's release notes
- [ ] **Integration test** — Testcontainers-equivalent fixture: spawn the LSP server against a tiny fixture workspace, exercise all three tools, assert payloads

## 0.4.0 — `kernel:*` family (blocked on `KernelDiagnostics` RFC)

> Goal: the bridge introspects a running kernel through a process-boundary adapter. Read-only. Preserves The Wall by construction.

- [ ] **`KernelDiagnostics` SPI RFC lands in `exeris-kernel/docs/rfc/`** — defines read-only surface, stability contract, JSON-over-stdio adapter shape
- [ ] **`KernelDiagnostics` SPI implementation in `exeris-kernel-spi`** — interface + records
- [ ] **Community provider in `exeris-kernel-community`** — implements the SPI against the in-process `KernelBootstrap` state
- [ ] **`exeris-kernel-diagnostics-cli`** — tiny Java executable shipped from `exeris-kernel-community`; reads JSON requests on stdin, writes responses on stdout; the bridge spawns this as a child process
- [ ] **`src/transport/kernel-adapter.ts`** — Node-side wrapper: spawn, framed JSON-over-stdio, lifecycle (start lazy, kill on exit)
- [ ] **`kernel:list_providers`** — provider class names + driver origin (community / enterprise) + which SPI each one provides
- [ ] **`kernel:list_capabilities`** — composed capability graph per [ADR-024](../exeris-docs/adr/ADR-024-capability-composition-model.md): nodes (`name`, `@Provides`, `@Requires`), edges (resolution arrows), phase state (`initialize` / `ready` / `drain` / `terminate`)
- [ ] **`kernel:get_bootstrap_dag`** — current state of the FOUNDATION / SERVICES / RUNTIME DAG (per `exeris-kernel/docs/subsystems/bootstrap.md`)
- [ ] **`kernel:describe_subsystem`** — drill into a specific subsystem (`memory`, `crypto`, `persistence`, `graph`, `transport`, `events`, `flow`, `http`)
- [ ] **Auth-free local mode** — the kernel adapter trusts the spawning process by default; if/when remote introspection lands, auth is layered in 0.6 (SSE + transport auth)
- [ ] **Integration test** — bridge → kernel adapter → minimal kernel instance, exercising every `kernel:*` tool

## 0.5.0 — MCP resources + prompts

> Goal: the bridge stops being tools-only. It publishes ADRs, HLA, whitepaper as MCP **resources** (URI-addressable) and ships canned **prompts** that bootstrap an agent into common Exeris workflows.

- [ ] **Resource registry** — `exeris://docs/adr/{NNN}`, `exeris://docs/hla`, `exeris://docs/whitepaper`, `exeris://docs/template/{ADR|RFC|RESEARCH}`
- [ ] **Resource subscriptions** — clients can subscribe to `exeris://docs/adr-index` and be notified when the registry changes (filesystem watcher)
- [ ] **Prompts**
  - [ ] `review-three-tier-violations` — pre-loads HLA §§2.2/3/4/5 + ADR-006 + ADR-024 + cap-tier Wall rule; instructs the agent to scan a diff for the ten drift patterns in `exeris-docs/CLAUDE.md`
  - [ ] `draft-adr` — pre-loads `ADR-TEMPLATE.md` + `adr-index.md` (for the next-free-number lookup); instructs the agent to ask Research/RFC/ADR shape question first
  - [ ] `route-this-task` — pre-loads the top-level routing rules from `~/exeris-systems/CLAUDE.md`; agent identifies the owning repo before touching anything
  - [ ] `wall-audit` — pre-loads ADR-006; agent scans a file/PR for Spring/Netty/servlet leakage
- [ ] **`prompts:list_repos`** — lookup of which repo owns which question, derived from the routing section

## 0.6.0 — SSE transport + hosted deployment

> Goal: the bridge runs as a hosted service for teams / customers who don't want to spawn a local Node process per agent. Multi-user, auth'd, observable.

- [ ] **SSE transport** — `@modelcontextprotocol/sdk` SSE server wired in alongside the existing stdio transport (selectable by `EXERIS_AI_BRIDGE_TRANSPORT=stdio|sse`)
- [ ] **Bearer-token auth** — minimal auth model for SSE; tokens stored as a hashed allowlist file or env-var allowlist
- [ ] **Per-token scoping** — token grants are scoped to tool families (`docs:*` / `lsp:*` / `kernel:*`) so a public-docs token can't introspect a running kernel
- [ ] **Dockerfile** — multi-stage build, distroless final image, non-root user, `~50MB`
- [ ] **Kubernetes manifest example** — `Deployment` + `Service` + `Ingress` template under `deploy/k8s/`
- [ ] **Multi-tenancy story** — one bridge instance can front several kernel adapters (`?kernel=app-a` URL param routes to the right child); explicitly out of scope until a customer asks for it, but the design is sketched

## 0.7.0 — observability + diagnostics

> Goal: the bridge is itself observable. JFR-equivalent telemetry. Self-diagnostic surface for debugging "why isn't this tool working".

- [ ] **`bridge:health`** — synthetic tool that checks (a) `EXERIS_DOCS_ROOT` resolves, (b) LSP child process responds to `initialize`, (c) kernel adapter responds to `kernel:ping`; returns a structured health report
- [ ] **`bridge:version`** — server version, MCP SDK version, Node version, configured roots, transport mode
- [ ] **Tool-call telemetry** — every tool invocation produces a structured log line: `{ tool, latencyMs, status, error? }`; stdout in dev, OTLP exporter as an opt-in dependency in prod
- [ ] **Slow-tool warning** — log line + MCP server-side notification when a tool call exceeds a per-tool threshold (`docs:* > 200ms`, `lsp:* > 1s`, `kernel:* > 500ms`)
- [ ] **Self-trace prompt** — `bridge-troubleshoot` prompt that walks an agent through diagnosing why a tool call failed

## 0.8.0 — security review + hardening

> Goal: external security review pass. Bridge can be exposed to untrusted agents (e.g. customer's own LLM, third-party MCP clients) without exfiltration risk.

- [ ] **Path-traversal audit** — formal review of every filesystem-touching code path; fuzz tests for `../`, symlinks, Windows drive letters
- [ ] **JSON-RPC injection audit** — LSP and kernel-adapter requests must escape correctly; no template-string concat of agent-supplied identifiers
- [ ] **Dependency audit** — `npm audit` clean; SBOM published with each release; `@modelcontextprotocol/sdk` pinned to a reviewed version
- [ ] **Resource-limit caps** — `docs:search` result size capped, `lsp:*` request budget per session capped, child-process memory limits
- [ ] **License notice** — generated `NOTICE.md` lists every third-party dep + license; CI gate fails if a non-permissive license sneaks in
- [ ] **Threat model doc** — `docs/threat-model.md` enumerating trust boundaries (agent ↔ bridge, bridge ↔ LSP, bridge ↔ kernel adapter, bridge ↔ filesystem)

## 0.9.0 — pre-GA polish

> Goal: every paper cut a 0.x adopter has reported is closed; docs are buyable; 1.0 surface is frozen in a release candidate.

- [ ] **Documentation site** — typedoc-generated tool reference + hand-written getting-started + IDE-integration guides (Claude Code, Cursor, Continue, Zed)
- [ ] **Example projects** — `examples/with-claude-code/`, `examples/with-cursor/`, `examples/with-mcp-inspector/`
- [ ] **`MIGRATION-0.x-to-1.0.md`** — every rename, schema change, or removal between 0.x and 1.0 enumerated
- [ ] **Release candidates** — `1.0.0-rc.1`, `rc.2` as the surface settles; community feedback window
- [ ] **Backward-compat policy doc** — `docs/compat-policy.md` makes the semver contract explicit (additive minor / breaking major / deprecation cycle length)

## 1.0.0 GA — stable MCP tool surface

> Goal: any 1.x release is source-compatible. Tool names, input schemas, output shapes don't change without a deprecation cycle.

- [ ] **Tool surface frozen** — names + input JSON Schemas + output shapes for `docs:*` (9 tools), `lsp:*` (3 tools), `kernel:*` (4 tools), `bridge:*` (2 tools) locked
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
| 0.3.0     | `exeris-platform`          | Three custom LSP requests in `exeris-platform-lsp` (`workspace/exerisDomains`, `…Describe`, `…Actions`)         |
| 0.4.0     | `exeris-kernel`            | `KernelDiagnostics` SPI + Community provider + `exeris-kernel-diagnostics-cli` Java executable; RFC must land first |
| 0.5.0     | `exeris-docs`              | Stable file layout for ADRs, HLA, whitepaper, templates (no new requirement; just don't restructure the tree)   |
| 0.6.0     | none                       | (self-contained — SSE + Docker + k8s are local concerns)                                                       |

## Tracking

- Per-milestone follow-ups: open issues with `milestone: 0.X.0` label on `github.com/exeris-systems/exeris-ai-bridge` (repo creation is the first 0.2.0 item).
- ADR amendments: any change to tool family scope, license, or process-boundary contract requires amending ADR-025 (or a successor ADR) before shipping.
