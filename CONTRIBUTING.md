---
title: "Contributing to exeris-ai-bridge"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-28
---

# Contributing to `exeris-ai-bridge`

How to build, test and release the bridge. The agent contract for this repository is in
[`AGENTS.md`](AGENTS.md); the founding decision is [ADR-025](docs/adr/ADR-025-ai-agent-bridge.md),
and the milestones are in [`ROADMAP.md`](ROADMAP.md).

## Architecture in one line

The bridge is a **separate process in a separate language** from the Java kernel. This is intentional and preserves [ADR-006 (The Wall)](https://github.com/exeris-systems/exeris-docs/blob/main/adr/ADR-006-spring-free-kernel-boundary.md) by construction — no AI-tooling code ever links into the kernel classpath.

```text
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

The diagram shows the sources behind the ecosystem families. The application-developer families need none of them: `build-*` and `caps-*` read the project's own build output, `sdk-*` and `build-get_starter` read the reference data bundled in the package, and `docs-*` answers from a bundled snapshot when there is no `exeris-docs` checkout. One tool starts a further process, per call: `build-preview_generation` runs the project's pinned generator (`java -jar` the `exeris-codegen-cli` jar, or `node` the installed `exeris-gen`) into a scratch directory and removes it when the call returns.

The repository is named *bridge*, not *mcp*: MCP is the first protocol surface, but the mission is
to bridge Exeris semantic surfaces to AI agents, and adjacent integrations (Claude Skills bundles,
agent-SDK adapters, later protocols) live here when they share that responsibility.

## Stack

- **Node 20+**, TypeScript 5.6+, ES2023 target.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) for the MCP server runtime.
- Stdio transport for local agent integration; a Streamable HTTP transport for a hosted endpoint serving the public families (`docs-*`, `sdk-*`, `bridge-*`) is planned for 0.10.0.

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

Once wired in, the bridge answers ecosystem-introspection questions directly from the `exeris-docs` registry, read from a checkout or, without one, from the bundled snapshot. A representative session — *"list all ADR-024-related context"*:

| Agent intent | Tool call | Returns |
| :--- | :--- | :--- |
| Enumerate the registry | `docs-list_adrs` | structured rows `{ number, numberPadded, title, owningRepo, scope, visibility, status, link }[]` (optional `status` filter) |
| Read the decision in full | `docs-get_adr` `{ "number": 24 }` | the authoritative ADR-024 markdown body (`number` is an **integer** of at least 1; a string such as `"024"` is rejected) |
| Find every mention | `docs-search` `{ "query": "ADR-024", "maxResults": 5 }` | `hits` of `{ path, line, snippet }` across the docs tree, with `hitCount` and `truncated` / safety caps |

You can drive the same handshake without an agent — pipe newline-delimited JSON-RPC straight at the stdio server:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs-get_adr","arguments":{"number":24}}}' \
  | node dist/server.js
```

`tools/list` advertises all 33 tool definitions (9 `docs-*`, 4 `lsp-*`, 4 `kernel-*`, 7 `build-*`, 2 `caps-*`, 5 `sdk-*`, 2 `bridge-*`); `tools/call` on `docs-get_adr` returns the ADR-024 body.

## Repository layout

```text
src/
  server.ts                  MCP server entry: composes the tool registries, resources and prompts
                             over the stdio transport
  instructions.ts            the `initialize` instructions handed to the model at connect time
  version.ts                 the package version, read from package.json
  config/env.ts              fail-soft env resolution: modes, per-family availability, launch ladder
  config/maven.ts            local Maven repository probing — offline, coordinate in / jar path out
  config/pom.ts              bounded, sandboxed pom.xml reading shared by SDK skew and the tooling pin
  config/tooling-pin.ts      the tooling version a project pins — app-parent, codegen plugin, or the
                             installed @exeris/codegen-ts; shared by generator resolution and skew
  fs/sandbox.ts              path-sandbox guard — reads resolve under a pinned root
  fs/watch.ts                bounded, root-confined directory watcher with glob matching — the LSP
                             workspace and the docs registry index subscription share it
  process/exit-hooks.ts      process-wide cleanup at exit: generator process groups, scratch
                             directories and watchers
  transport/
    lsp-framing.ts           LSP base-protocol (Content-Length) message codec
    lsp-client.ts            JSON-RPC client over a child exeris-platform-lsp process, including the
                             watched-files forwarding behind the `watch` field of `bridge-health`
    ndjson-framing.ts        newline-delimited JSON message codec (kernel CLI)
    kernel-adapter.ts        NDJSON client over a child exeris-kernel-diagnostics-cli process
  tools/
    types.ts                 Shared ToolDefinition / ToolHandler types
    unavailable.ts           per-family availability guard for dark families
    docs/
      index.ts               docs-* — 9 filesystem-bound tools (list/get ADRs, templates,
                             HLA, whitepaper, search, per-repo docs surface)
      content.ts             registry-tier reads (index, ADR, HLA, whitepaper, templates, drift
                             patterns) shared by the tools, the resources and the prompts
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
    build/index.ts           registers the seven build-* tools; build-list_domains,
                             build-get_domain_metadata, build-get_detach_state and
                             build-explain_diagnostic read the annotation processor's own output
                             in target/classes/exeris-metadata and the codegen output tree in
                             src/main/generated/java
    build/starter.ts         build-get_starter — pom.xml / package.json for a new application, from
                             the vendored exeris-app-bom triple; bundled data only, writes nothing
    build/tooling-skew.ts    toolingSkew — the project's pinned tooling release against the one the
                             vendored generator catalogue came from
    build/shapes.ts          envelope validation (schemaVersion + ADR-042 sourceDigest) and the
                             filename-prefix decoding; the AST body passes through verbatim
    build/artefacts.ts       codegen-manifest parse + per-path explanation (which generator,
                             what drove it, candidates[] when a path is ambiguous), from the
                             vendored generator catalogue; reads what was emitted, never predicts it
    build/diagnostics.ts     decoding of the build's own diagnostics, keyed on the ADR-095
                             EXT-<AREA>-<NNNN> identifier (text anchors only for output from
                             tooling before 0.9.0); an unknown identifier is reported, not guessed
    build/diagnostics-catalogue.ts  the identifier catalogue diagnostics.ts looks up
    build/preview/           build-preview_generation, the only tool that starts a generator
      tool.ts                the tool: validate the metadata, resolve the generator, run it, diff
      validate-metadata.ts   the metadata corpus check that runs before any generator starts
      resolve-generator.ts   the pinned generator, locally — the exeris-codegen-cli jar in the
                             local Maven repository, or exeris-gen in the project's node_modules —
                             and its launch; never downloaded, never substituted
      workdir.ts             the scratch directory, proven to lie outside the project and
                             ecosystem roots
      runner.ts              bounded child-process run: timeout, output cap, process-group kill,
                             a fixed environment allowlist
      seed.ts                copies the project's committed generated tree into the scratch output
      ts-config.ts           the TypeScript generator's output root, from the project's codegen config
      diff.ts                lists what the run produced and diffs it against the committed tree
      cleanup.ts             re-exports the exit registry for the preview modules
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
  resources/
    docs.ts                  the exeris://docs/* resource lists and reads, over docs/content.ts
    sdk.ts                   the exeris://sdk/brief-schema resource, read from the bundle
    subscriptions.ts         resources/subscribe for exeris://docs/adr-index, on the shared watcher
    index.ts                 wires the resource handlers and the subscription state to the server
  prompts/
    index.ts                 the eight stateless prompt templates: list, argument validation, render
    context.ts               what a prompt embeds — docs resources and bundled SDK data
    types.ts                 prompt definition shape and the argument bounds
    *.ts                     one file per prompt (author-domain, diagnose-build-failure, draft-adr,
                             explain-my-build, migrate-sdk-version, review-three-tier-violations,
                             route-this-task, wall-audit)
  data/bundle.ts             reader for the bundled reference corpus — manifest parse,
                             per-entry SHA-256 verification, sandboxed to data/
  data/generator-catalogue.ts  loader and matcher for the vendored exeris-tooling generator
                             catalogue (ADR-097); never throws, reports why it is absent
  data/app-starter.ts        reads the tested tooling + kernel + SDK triple out of the exeris-app-bom
                             POMs (ADR-091) at pack time and loads it back; never throws
  data/docs-snapshot.ts      loads the bundled docs registry snapshot and verifies every digest
  data/docs-snapshot-build.ts  assembles that snapshot at pack time from each repository's default
                             branch (or a directory named by EXERIS_DOCS_SNAPSHOT_SOURCE)
  data/vendor-resolver.ts    finds the released jars and POMs in the local Maven repository and
                             extracts the corpus entries from them at pack time
scripts/
  vendor-reference-data.mjs  generates + verifies data/ at pack time (`prepack`)
  p2-smoke.mjs               zero-checkout smoke test — packs, installs and interrogates
                             the tarball on a scrubbed environment (CI job `p2-smoke`)
  build-mcpb.mjs             builds the Claude Desktop bundle (.mcpb) from the npm tarball
server.json                  MCP Registry entry; held equal to package.json by a test
docs/
  configuration.md           how each EXERIS_* variable resolves
  repo-review-rules.md       this repository's step of the organisation's pull request review
  adr/
    ADR-025-ai-agent-bridge.md   Founding ADR (authoritative copy — cross-repo per ADR-020)
    ADR-0NN.link.md          stubs for the cross-repo decisions this repository consumes
```

## Releasing

A `v*` tag runs [`release.yml`](.github/workflows/release.yml). Its `package` job is a dry run on every tag, and the whole run for a manual dispatch against an existing tag: it checks the tag against `package.json` and `server.json`, fetches the vendored artefacts with Maven, runs the tests and `smoke:p2`, packs the tarball (prepack vendors, strictly, the SDK reference data, the generator catalogue, the application starter and the docs registry snapshot), builds the `.mcpb` bundle from that tarball, and keeps all three with a `SHA256SUMS` as a workflow artifact. The fetched artefacts are the two `exeris-sdk` jars (`exeris-sdk-annotations`, `exeris-sdk-source-model`), the `exeris-codegen-java` jar and the `exeris-app-bom`, `exeris-app-parent` and `exeris-app-starter` POMs. The job needs two repository variables: `EXERIS_SDK_VERSION` — the released `exeris-sdk` version the annotation catalog, AST schema and brief schema are vendored from (`0.13.1`) — and `EXERIS_TOOLING_VERSION` — the released `exeris-tooling` version the generator catalogue is vendored from, out of `eu.exeris:exeris-codegen-java`, and the application starter from the three POMs (`0.10.0`). Everything is fetched from Maven Central; the secret `PACKAGES_READ_TOKEN` is consulted only for the two SDK jars, and only when set, for a release not yet on Central. The jobs that publish additionally need `RELEASE_PUBLISH`, below.

Publishing runs only for a pushed tag when the repository variable `RELEASE_PUBLISH` is `true`, in two jobs.

`npm-stage` runs in the `npm-publish` environment and stages the tarball the `package` job built with `npm stage publish`, as `@exeris/ui-kit` in `exeris-sdk` and `@exeris/codegen-ts` in `exeris-tooling` are staged. The version goes live only when a maintainer approves it with 2FA: `npm stage approve <stage-id>`, or Approve under the package's Staged Packages tab on npmjs.com. It authenticates with the organisation secret `NPM_TOKEN`, an npm granular access token with "Read and write (stage only)" on the `@exeris` scope, so CI holds no credential that can put a version on the registry by itself. `publishConfig.provenance` signs a provenance statement through the job's OIDC token.

`registry` waits up to an hour for the approved version to be live on npm, then publishes to the MCP Registry and creates the GitHub Release with the tarball, the bundle and the checksums, using the tag message as the release notes. Approved later than that, re-run the `registry` job.

The MCP Registry needs no secret: it verifies the organisation through GitHub OIDC and checks `server.json` against the published package's `mcpName`. `src/release-metadata.test.ts` holds the two equal on every change.
