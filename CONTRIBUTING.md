---
title: "Contributing to exeris-ai-bridge"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-21
---

# Contributing to `exeris-ai-bridge`

How to build, test and release the bridge. The agent contract for this repository is in
[`AGENTS.md`](AGENTS.md); the founding decision is [ADR-025](docs/adr/ADR-025-ai-agent-bridge.md),
and the milestones are in [`ROADMAP.md`](ROADMAP.md).

## Architecture in one line

The bridge is a **separate process in a separate language** from the Java kernel. This is intentional and preserves [ADR-006 (The Wall)](https://github.com/exeris-systems/exeris-docs/blob/main/adr/ADR-006-spring-free-kernel-boundary.md) by construction — no AI-tooling code ever links into the kernel classpath.

```
┌─────────────────────┐      MCP/stdio       ┌────────────────────┐
│   Agent (Claude,    │ ───────────────────► │ exeris-ai-bridge   │
│   Cursor, Copilot)  │                      │  (Node 20+, TS)    │
└─────────────────────┘                      └────────┬───────────┘
                                                      │
                              ┌───────────────────────┼─────────────────────────┐
                              │                       │                         │
                              ▼                       ▼                         ▼
                   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
                   │ exeris-docs/     │   │ exeris-platform- │   │ Running Exeris kernel    │
                   │ (filesystem)     │   │ lsp (JSON-RPC)   │   │ (JSON-over-stdio adapter │
                   │                  │   │                  │   │  to KernelDiagnostics)   │
                   └──────────────────┘   └──────────────────┘   └──────────────────────────┘
```

The repository is named *bridge*, not *mcp*: MCP is the first protocol surface, but the mission is
to bridge Exeris semantic surfaces to AI agents, and adjacent integrations (Claude Skills bundles,
agent-SDK adapters, later protocols) live here when they share that responsibility.

## Stack

- **Node 20+**, TypeScript 5.6+, ES2023 target.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) for the MCP server runtime.
- Stdio transport for local agent integration; a Streamable HTTP transport for a hosted endpoint serving the public families (`docs:*`, `sdk:*`, `bridge:*`) is planned for 0.10.0.

## Build & test

```sh
npm install
npm run build
npm start                    # stdio MCP server
```

For development with auto-reload:

```sh
npm run dev
```

Tests, and the zero-checkout check that CI runs on every PR:

```sh
npm test                     # unit + shape tests (builds first)
npm run test:coverage        # the same tests under c8; writes coverage/lcov.info for Sonar
npm run lint                 # type-aware ESLint over src/ and scripts/
npm run smoke:p2             # pack, install into a scratch dir, speak MCP to the tarball
```

`smoke:p2` is the one test that does not run against the source tree. It builds the real
package, installs it somewhere that has only an application project, points `HOME` at an
empty directory and scrubs every `EXERIS_*` variable — the machine an application developer
actually has. It must be launched through npm (`npm run smoke:p2 -- --keep` leaves the scratch
directory behind for inspection) — that is how it resolves the npm binary to an
absolute path instead of a `PATH` lookup, and it guarantees the pack and the
install run on the same npm that manages the project.

## Running from a clone

To run from a clone, add an entry to your `.claude/settings.json` MCP servers list. For an application, nothing needs setting — start the agent inside your project and the bridge finds its `pom.xml`:

```json
{
  "mcpServers": {
    "exeris": {
      "command": "node",
      "args": ["/abs/path/to/exeris-ai-bridge/dist/server.js"]
    }
  }
}
```

A contributor working on the ecosystem itself chooses contributor mode explicitly and points at the checkout:

```json
{
  "mcpServers": {
    "exeris": {
      "command": "node",
      "args": ["/abs/path/to/exeris-ai-bridge/dist/server.js"],
      "env": {
        "EXERIS_BRIDGE_MODE": "contributor",
        "EXERIS_DOCS_ROOT": "/abs/path/to/exeris-docs"
      }
    }
  }
}
```

`data/` is generated at pack time and not committed, so a bridge run from a clone has no bundled
reference data until `npm run vendor:data` runs; `bridge-version` says which state it is in. See the
[configuration reference](docs/configuration.md) for every variable.

## Try it end to end

Once wired in, the bridge answers ecosystem-introspection questions directly from `exeris-docs`. A representative session — *"list all ADR-024-related context"*:

| Agent intent | Tool call | Returns |
|:---|:---|:---|
| Enumerate the registry | `docs-list_adrs` | structured rows `{ number, title, owningRepo, scope, visibility, status, link }[]` (optional `status` filter) |
| Read the decision in full | `docs-get_adr` `{ "number": 24 }` | the authoritative ADR-024 markdown body (`number` is an **integer**, padded forms like `024` are normalized) |
| Find every mention | `docs-search` `{ "query": "ADR-024", "maxResults": 5 }` | `{ path, line, snippet }[]` hits across the docs tree, with `truncated` / safety caps |

You can drive the same handshake without an agent — pipe newline-delimited JSON-RPC straight at the stdio server:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs-get_adr","arguments":{"number":24}}}' \
  | node dist/server.js
```

`tools/list` advertises all 31 tool definitions (9 `docs:*`, 4 `lsp:*`, 4 `kernel:*`, 5 `build:*`, 2 `caps:*`, 5 `sdk:*`, 2 `bridge:*` — all live); `tools/call` on `docs-get_adr` returns the ADR-024 body.

## Repository layout

```
src/
  server.ts                  MCP server entry, tool registry, stdio transport
  instructions.ts            the `initialize` instructions handed to the model at connect time
  config/env.ts              fail-soft env resolution: modes, per-family availability, launch ladder
  config/maven.ts            local Maven repository probing — offline, coordinate in / jar path out
  fs/sandbox.ts              path-sandbox guard — reads resolve under a pinned root
  transport/
    lsp-framing.ts           LSP base-protocol (Content-Length) message codec
    lsp-client.ts            JSON-RPC client over a child exeris-platform-lsp process
    ndjson-framing.ts        newline-delimited JSON message codec (kernel CLI)
    kernel-adapter.ts        NDJSON client over a child exeris-kernel-diagnostics-cli process
  tools/
    types.ts                 Shared ToolDefinition / ToolHandler types
    unavailable.ts           per-family availability guard for dark families
    docs/
      index.ts               docs:* — 9 filesystem-bound tools (list/get ADRs, templates,
                             HLA, whitepaper, search, per-repo docs surface)
      adr-index.ts           parser for exeris-docs/adr-index.md
    lsp/index.ts             lsp-list_domains, lsp-describe_domain, lsp-list_actions,
                             lsp-preview_mutation — LSP proxy (bound to the exeris/* slice,
                             shape-validated; preview_mutation calls exeris/previewMutation and
                             never writes)
    lsp/shapes.ts            exeris/* wire shapes + validators (DomainSummary / DomainDescription
                             with relationships[] and sourceDigest / ActionSummary / MutationPreview)
    kernel/index.ts          kernel-list_providers, kernel-get_bootstrap_dag, kernel-describe_subsystem,
                             kernel-get_jvm_ergonomics — KernelDiagnostics proxy over NDJSON, one tool
                             per SPI method (cap-blind — no list_capabilities)
    kernel/shapes.ts         KernelDiagnostics wire shapes + validators (Providers/BootstrapDag/
                             Subsystem/RuntimeErgonomics)
    build/index.ts           build-list_domains, build-get_domain_metadata,
                             build-explain_artefacts, build-get_detach_state,
                             build-explain_diagnostic — reads the
                             annotation processor's own output in target/classes/exeris-metadata
                             and the codegen output tree in src/main/generated/java
    build/shapes.ts          envelope validation (schemaVersion + ADR-042 sourceDigest) and the
                             filename-prefix decoding; the AST body passes through verbatim
    build/artefacts.ts       codegen-manifest parse + per-path explanation (which generator,
                             what drove it, candidates[] when a path is ambiguous), from the
                             vendored generator catalogue; reads what was emitted, never predicts it
    build/diagnostics.ts     catalogue of the build's own diagnostics, keyed on the ADR-095
                             EXT-<AREA>-<NNNN> identifier (text anchors only for output from
                             tooling before 0.9.0); an unknown identifier is reported, not guessed
    caps/index.ts            caps-list_capabilities, caps-describe_composition — reads the
                             build-time cap-manifest.json of the user's own project; never
                             re-resolves the @Requires→@Provides DAG
    caps/shapes.ts           cap-manifest wire shapes + validators (CapManifest/Stamp/Module)
    sdk/index.ts             sdk-list_annotations, sdk-describe_annotation, sdk-get_scoping_rules,
                             sdk-list_deprecations, sdk-get_ast_schema — the bundled annotation
                             catalog, AST schema, deprecations and authored scoping rules
    sdk/shapes.ts            annotation catalog and AST schema wire shapes and parsers
    sdk/rules.ts             the authored scoping rules (@Field vs @Validation, …)
    sdk/skew.ts              project SDK version and skew from pom.xml — a direct dependency, an
                             exeris.sdk.version property, or the app BOM chain in the local ~/.m2
    bridge/index.ts          bridge-version, bridge-health — the bridge's own diagnostic
                             surface (never gated, never spawns)
  data/bundle.ts             reader for the bundled reference corpus — manifest parse,
                             per-entry SHA-256 verification, sandboxed to data/
  data/generator-catalogue.ts  loader and matcher for the vendored exeris-tooling generator
                             catalogue (ADR-097); never throws, reports why it is absent
scripts/
  vendor-reference-data.mjs  generates + verifies data/ at pack time (`prepack`)
  p2-smoke.mjs               zero-checkout smoke test — packs, installs and interrogates
                             the tarball on a scrubbed environment (CI job `p2-smoke`)
  build-mcpb.mjs             builds the Claude Desktop bundle (.mcpb) from the npm tarball
server.json                  MCP Registry entry; held equal to package.json by a test
docs/
  adr/
    ADR-025-ai-agent-bridge.md   Founding ADR (authoritative copy — cross-repo per ADR-020)
```

## Releasing

A `v*` tag runs [`release.yml`](.github/workflows/release.yml). Its `package` job is a dry run on every tag: it checks the tag against `package.json` and `server.json`, runs the tests and `smoke:p2`, packs the tarball (prepack vendors the SDK reference data and the docs registry snapshot, strictly), builds the `.mcpb` bundle from that tarball, and keeps all three with a `SHA256SUMS` as a workflow artifact. It needs two repository variables: `EXERIS_SDK_VERSION` — the released `exeris-sdk` version the annotation catalog and AST schema are vendored from (`0.12.0`) — and `EXERIS_TOOLING_VERSION` — the released `exeris-tooling` version the generator catalogue is vendored from, out of `eu.exeris:exeris-codegen-java` (`0.10.0`). Both jars are fetched from Maven Central; the secret `PACKAGES_READ_TOKEN` is consulted only when set, for a release not yet on Central. The `publish` job additionally needs `RELEASE_PUBLISH`, below.

The `publish` job runs only for a pushed tag when the repository variable `RELEASE_PUBLISH` is `true`, in the `release` environment. It publishes to npm with provenance, then to the MCP Registry, then creates the GitHub Release with the tarball, the bundle and the checksums, using the tag message as the release notes.

The `release` environment carries no protection rule, as in the organisation's other publishing repositories: pushing the `v*` tag is the release decision. The first publish authenticates with the organisation secret `NPM_TOKEN`, because npm can configure a trusted publisher only for a package that exists. Afterwards, configure npm trusted publishing for the package (workflow `release.yml`, environment `release`): every later publish authenticates by OIDC and carries provenance.

The MCP Registry needs no secret: it verifies the organisation through GitHub OIDC and checks `server.json` against the published package's `mcpName`. `src/release-metadata.test.ts` holds the two equal on every change.
