# exeris-ai-bridge

**Model Context Protocol server exposing Exeris ecosystem surfaces to AI agents.**

`exeris-ai-bridge` is a public, Apache 2.0 MCP server that publishes three surfaces from the Exeris ecosystem to AI agents (Claude Code, Cursor, Copilot Workspace, and any other MCP-aware client):

- **Studio / LSP bridge** — query `@ExerisDomain` types, action signatures, codegen artefacts from a running `exeris-platform-lsp` session.
- **Docs / ADR registry** — search and fetch ADRs, HLA, whitepaper, and templates from `exeris-docs`.
- **Kernel introspection** — read-only inspection of a running kernel's provider registry, bootstrap/subsystem DAG, and per-subsystem detail (via the `KernelDiagnostics` SPI). Cap-blind by design: capability composition is a build-time tooling/platform surface, not a kernel one (see [ADR-024](../exeris-docs/adr/ADR-024-capability-composition-model.md) 2026-06-17 amendment and ADR-025 §"`kernel:*` Is Cap-Blind").

The repo is named *bridge*, not *mcp*: MCP is the first protocol surface, but the mission is "bridge Exeris semantic surfaces to AI agents" — adjacent integrations (Claude Skills bundles, agent-SDK adapters, future protocols) live here when they share that responsibility.

See [`docs/adr/ADR-025-ai-agent-bridge.md`](docs/adr/ADR-025-ai-agent-bridge.md) for the founding decision.

## Status

**0.5.1 — zero-checkout mode: the bridge boots and answers on a machine with no ecosystem checked out.** ADR-025 ACCEPTED (2026-05-15), five amendments since. All six tool families are implemented and verified end-to-end: `docs:*` (9 tools, filesystem-bound against `exeris-docs`), `lsp:*` (3 tools, bound to the read-only `exeris/*` slice in `exeris-platform-lsp`), `kernel:*` (4 tools, one per `KernelDiagnostics` SPI method, over NDJSON — read-only and cap-blind by construction, so no `kernel-list_capabilities`), `build:*` (4 tools, reading the `DomainMetadata` the developer's own build emitted and the codegen output tree beside it), `caps:*` (2 tools, reading the build-time `cap-manifest.json` of the same project), and `bridge:*` (2 tools, the server's own diagnostic surface). Both child families keep an opt-in live integration test (`EXERIS_LSP_IT=1`, `EXERIS_KERNEL_IT=1`).

What 0.5.0 adds is not tools but the ability to run without the ecosystem: `loadConfig()` never throws, a dependency that does not resolve takes its own family dark with a `reason` and a `remedy`, `tools/list` stays invariant so the 1.0 freeze remains implementable, each child is resolved through a launch ladder (`EXERIS_*_COMMAND` → `EXERIS_*_JAR` → local Maven repository → source tree) whose rung order follows the persona, and a read-only reference corpus ships inside the package. A CI job (`scripts/p2-smoke.mjs`) packs the tarball, installs it into a scratch directory holding only an application project, and speaks MCP to it with an empty `HOME` and no `EXERIS_*` set — the P2 claim is tested, not asserted.

Two upstream dependencies remain open and are documented rather than papered over: `exeris-platform-lsp` publishes no runnable jar, so `lsp:*` has no local-repository rung and stays contributor-only; and the published `exeris-kernel-diagnostics-cli:0.11.0` jar does not boot — **fixed upstream on the 0.12 development line, so the remedy arrives with kernel 0.12.0 rather than with a change here** (see the note under [Wiring into an agent](#wiring-into-an-agent)). Next: `build:*` / `caps:*` (0.6.0), which read the developer's own project and build artefacts and whose producers are already released; then `sdk:*` (0.7.0) — the annotation catalog that fills the bundle, answered upstream on the `exeris-sdk` 0.12.0 line and waiting on that release. MCP resources + prompts are at 0.9.0. **0.5.1 is not published to npm.** Publication waits on kernel 0.12.0, sdk 0.12.0 and tooling 0.9.0 reaching Maven Central. What makes that gate matter: until they do, every `eu.exeris:*` artifact the launch ladder resolves lives in GitHub Packages, which needs a `PACKAGES_READ_TOKEN` — so a first npm release would reach exactly the P2 developers who cannot resolve what it points at.

Full milestone breakdown: [`ROADMAP.md`](ROADMAP.md) — from 0.1.0 (scaffold) through 1.0.0 GA (stable MCP tool surface).

## Stack

- **Node 20+**, TypeScript 5.6+, ES2023 target.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) for the MCP server runtime.
- Stdio transport for local agent integration; SSE transport added later if hosted deployment is needed.

## Architecture in one line

The bridge is a **separate process in a separate language** from the Java kernel. This is intentional and preserves [ADR-006 (The Wall)](../exeris-docs/adr/ADR-006-spring-free-kernel-boundary.md) by construction — no AI-tooling code ever links into the kernel classpath.

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

## Build & run

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
npm run smoke:p2             # pack, install into a scratch dir, speak MCP to the tarball
```

`smoke:p2` is the one test that does not run against the source tree. It builds the real
package, installs it somewhere that has only an application project, points `HOME` at an
empty directory and scrubs every `EXERIS_*` variable — the machine an application developer
actually has. It must be launched through npm (`npm run smoke:p2 -- --keep` leaves the scratch
directory behind for inspection) — that is how it resolves the npm binary to an
absolute path instead of a `PATH` lookup, and it guarantees the pack and the
install run on the same npm that manages the project.

## Wiring into an agent

For Claude Code, add an entry to your `.claude/settings.json` MCP servers list:

```json
{
  "mcpServers": {
    "exeris": {
      "command": "node",
      "args": ["/abs/path/to/exeris-ai-bridge/dist/server.js"],
      "env": {
        "EXERIS_DOCS_ROOT": "/abs/path/to/exeris-docs"
      }
    }
  }
}
```

**Every one of these variables is optional, and none of them can stop the server from booting.** Config resolution never fails: a dependency that does not resolve disables its own family and leaves the rest running. The tool surface does not change — `tools/list` always advertises all 24 tools, because 1.0 freezes it under semver and clients cache it — but a call into a disabled family returns a structured `family_unavailable` result naming the reason and the remedy instead of a transport error. A one-line boot summary (`mode=… docs=… lsp=… kernel=… build=… caps=…`) goes to stderr, which MCP clients surface in their logs.

**Tool names use `family-tool`, not `family:tool`.** The families are still namespaced — `docs:*`, `lsp:*`, `kernel:*`, `bridge:*` name the *family* throughout this repo and in ADR-025 — but the name that goes on the wire separates the two halves with a hyphen, because MCP clients do not reliably resolve a `:` in a tool name. Nothing else about the surface changed: the prefix still identifies the family, and `bridge-health` still reports per-family state under its family key.

**The server also ships `instructions`.** MCP delivers them in the `initialize` response, so the client can put them in front of the model *before* it calls anything — which is the only point at which a wrong architectural assumption is still cheap. They stay a route rather than a cheat sheet: what this server is, that every tool is a read, which family answers which question, the state each family resolved to in this session, and one correction that an agent trained mostly on Spring needs first — Exeris has no Spring context, no DI container, and no JPA or Hibernate anywhere in the kernel, SDK or build tooling. Framework facts themselves stay in the documents the tools serve; copied into the instructions they would be a second, unversioned copy that drifts.

When something is dark, **`bridge-health` is the tool to call**. It reports the resolved mode, every family's state with its reason and remedy, and — for the two families backed by a child process — that process's current state, *without starting it*. `bridge-version` identifies the build the answer came from. Both are read-only, cost nothing, and are never themselves gated: a diagnostic that goes dark along with what it diagnoses would be worthless. Deliberately absent is a "probe" that spawns the children to check they launch — the families' own tools answer that by doing the real work, and the outcome then shows up in the next `bridge-health`.

`EXERIS_DOCS_ROOT` points at the `exeris-docs` checkout the `docs:*` tools read from. It is **optional when the bridge is cloned as a sibling of `exeris-docs`** under `~/exeris-systems/` (the default resolves `../exeris-docs` relative to the install) — set it explicitly for npm-installed or relocated deployments. The filesystem sandbox is anchored on this root and its sibling repos; the server refuses to read anything outside it. With no checkout to resolve, `docs:*` is simply unavailable — the expected state when building an application *on* Exeris rather than working *on* Exeris.

`EXERIS_PROJECT_ROOT` points at **the developer's own project** — the tree `build:*` and `caps:*` report on. It is optional: with nothing set, the bridge walks up from its working directory to the nearest `pom.xml`, which is the right answer when an agent starts the server inside the project it is working on, and lands on the owning module rather than the aggregator in a multi-module build. Set it explicitly when the agent's working directory is somewhere else. An explicit root is taken as given and is **not** required to contain a `pom.xml` — naming it is how you escape our guessing. Reads are sandboxed to this root exactly as `docs:*` reads are sandboxed to the docs root, including for paths the bridge builds itself.

`EXERIS_BRIDGE_MODE` (optional, `auto` | `contributor` | `app`, default `auto`) records which persona the environment looks like — `auto` infers it from whether an ecosystem checkout resolved. It is **descriptive, not a mask**: pinning `app` does not hide `docs:*` when the docs checkout is present, because availability has exactly one source of truth (did the dependency resolve). What pinning `contributor` does buy you is a louder failure — missing roots are then reported as a misconfiguration rather than as the ordinary application-developer state.

Both child-process families resolve their launch spec through a **ladder**, first hit wins, nothing on it touches the network:

| rung | how | `source` in `bridge-health` |
|---|---|---|
| 1 | `EXERIS_LSP_COMMAND` / `EXERIS_KERNEL_COMMAND` — a full command line | `env-command` |
| 2 | `EXERIS_LSP_JAR` / `EXERIS_KERNEL_JAR` — a jar you already have | `env-jar` |
| 3 | a published jar in your local Maven repository, by coordinate | `m2` |
| 4 | `mvn exec:java` against the sibling module, if its pom is there | `source-tree` |

Rungs 3 and 4 **swap order by mode**: in contributor mode the source tree wins, because someone with the checkout is working *on* that tree and a released jar would quietly answer for code they are not editing; in app mode the published jar wins. That is preference, not gating — whichever is second still fires when the first cannot.

Rung 3 finds the local repository at `EXERIS_MAVEN_REPO`, then `<localRepository>` in `~/.m2/settings.xml`, then `~/.m2/repository`. The version is the newest **release** of the anchor artifact present there (`exeris-kernel-core` for the kernel CLI) — not the version your project's dependency graph resolves, which would require a Maven invocation on the boot path. `EXERIS_KERNEL_VERSION` pins it when those differ. Jar launches use `$JAVA_HOME/bin/java` when `JAVA_HOME` is set, else `java`; rung 1 is the escape hatch when you need something else. `lsp:*` has no rung 3 yet: the published `exeris-platform-lsp` jar carries no `Main-Class`, so probing for it would produce a launch that fails at startup.

`EXERIS_LSP_COMMAND` (optional) is how the `lsp:*` family launches its `exeris-platform-lsp` child — a whitespace-separated command + args (no shell quoting; the process is exec'd directly). The source-tree rung runs `mvn -q -f <ecosystemRoot>/exeris-platform/exeris-platform-lsp/pom.xml exec:java` (`-q` keeps Maven's own logging off the JSON-RPC stdout). The child is spawned lazily on the first `lsp:*` call and cached; its stderr is inherited into the bridge's logs. `lsp:*` calls return validated data against a running server; a server build predating the `exeris/*` slice yields a structured "update the LSP server" result rather than failing. The integration test confirms the default `exec:java` launch keeps protocol frames clean on stdout (the JVM logs to stderr), so no `exec:exec` workaround is needed.

`EXERIS_LSP_WORKSPACE` (optional) is the workspace root the LSP server indexes for `@ExerisDomain` sources, sent as `rootUri` in the `initialize` handshake. It defaults to the bridge's working directory (the project it was spawned in). With no resolvable workspace the server returns an empty index, so `lsp:*` tools answer `[]`.

`EXERIS_KERNEL_COMMAND` (optional) is how the `kernel:*` family launches its `exeris-kernel-diagnostics-cli` child — a whitespace-separated command + args (no shell quoting; exec'd directly), spawned lazily on the first `kernel:*` call and cached. It defaults to `mvn -q -f <ecosystemRoot>/exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml exec:java -Dexec.mainClass=eu.exeris.kernel.diagnostics.cli.DiagnosticsCli` (`-q` keeps Maven's logging off the NDJSON stdout; the CLI logs to stderr, which is inherited into the bridge's logs). The CLI boots the kernel in **read-only inspect mode** and speaks newline-delimited JSON; the bridge correlates responses FIFO and validates each snapshot against its `KernelDiagnostics` wire shape. A pre-built shaded jar is the faster override, and **from kernel 0.11.0 it needs no special flags**: `EXERIS_KERNEL_COMMAND="java -jar /abs/…/exeris-kernel-diagnostics-cli-<ver>.jar"`. The kernel went preview-clean at 0.11.0 (ADR-066: "the DISTRIBUTED artifact is preview-clean" — preview is now bound to test-compile and surefire only), and the published jars put the boundary exactly there: `0.10.2` has 12 preview-stamped classes out of 799, `0.11.0` has 0 out of 897. On an **older** jar you need `java --enable-preview -jar …` and the JDK it was built on; the JVM says so itself (`UnsupportedClassVersionError: Preview features are not enabled … Try running with '--enable-preview'`) and the bridge passes that message through. The same jar is published, so the path may equally be a local Maven repo coordinate — which is what the ladder's `m2` rung resolves for you.

> **Known upstream issue — fixed upstream, not yet released (verified 2026-08-27).** The published `exeris-kernel-diagnostics-cli:0.11.0` shaded jar boots the kernel and then fails in `CommunityJsonMappers` with `NoClassDefFoundError: com/fasterxml/jackson/annotation/JsonSerializeAs`. The CLI declared its own Jackson 2 protocol codec while the kernel it boots uses Jackson 3 (`tools.jackson`), and the two are not independent: they **share** the `com.fasterxml.jackson.core:jackson-annotations` artifact, of which Maven resolves exactly one version. The CLI's direct Jackson 2 dependency sat a level nearer than the kernel's transitive Jackson 3, so nearest-wins pinned annotations to 2.18.7 — below the 2.21 that `jackson-databind` 3.x needs. Unrelated to preview: identical with and without the flag. **Fixed upstream on the 0.12 development line** (the CLI drops its own Jackson and uses the BOM-managed one), so the remedy ships with kernel 0.12.0; nothing changes in this repo. Until that release, the `m2` rung resolves a launch that fails on first call, and `EXERIS_KERNEL_COMMAND` pointed at a source-tree build is the way round it. If the CLI is missing or fails to boot, `kernel:*` calls return a structured "set EXERIS_KERNEL_COMMAND / start the CLI" result rather than crashing.

### Bundled reference data

The published package carries a small read-only corpus so an application developer with **no ecosystem checkout and no network** still gets grounded answers. It is generated at pack time by `scripts/vendor-reference-data.mjs`, and `data/` is deliberately **not committed** — which means a bridge run from a source checkout has no bundle, and reports that plainly rather than pretending.

`bridge-version` reports which state you are in:

```jsonc
"bundle": { "state": "unavailable", "reason": "No bundled reference data is present…", "remedy": "…run npm run vendor:data…" }
"bundle": { "state": "available", "generatedAt": "…", "bridgeVersion": "0.5.1", "entryCount": 0, "sourceArtifacts": [] }
```

At 0.5.0 the bundle ships with **zero entries** on purpose: this milestone builds the mechanism — manifest, loader, integrity check, packaging — and the `sdk:*` family fills it with the annotation catalog and AST schema at 0.7.0. Every entry carries a SHA-256 that is verified on each read (a truncated file parses fine and is quietly wrong) and a `sourceArtifact` coordinate, so an answer can say which upstream release it reflects.

For other MCP-aware clients, point at the same `node dist/server.js` invocation over stdio.

## Try it (end-to-end)

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

`tools/list` advertises all 24 tool definitions (9 `docs:*`, 3 `lsp:*`, 4 `kernel:*`, 4 `build:*`, 2 `caps:*`, 2 `bridge:*` — all live); `tools/call` on `docs-get_adr` returns the ADR-024 body.

## Repo layout

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
    lsp/index.ts             lsp-list_domains, lsp-describe_domain, lsp-list_actions — LSP proxy
                             (Phase 3b: bound to the exeris/* slice, shape-validated)
    lsp/shapes.ts            exeris/* wire shapes + validators (DomainSummary / DomainDescription / ActionSummary)
    kernel/index.ts          kernel-list_providers, kernel-get_bootstrap_dag, kernel-describe_subsystem,
                             kernel-get_jvm_ergonomics — KernelDiagnostics proxy over NDJSON, one tool
                             per SPI method (cap-blind — no list_capabilities)
    kernel/shapes.ts         KernelDiagnostics wire shapes + validators (Providers/BootstrapDag/
                             Subsystem/RuntimeErgonomics)
    build/index.ts           build-list_domains, build-get_domain_metadata,
                             build-explain_artefacts, build-get_detach_state — reads the
                             annotation processor's own output in target/classes/exeris-metadata
                             and the codegen output tree in src/main/generated/java
    build/shapes.ts          envelope validation (schemaVersion + ADR-042 sourceDigest) and the
                             filename-prefix decoding; the AST body passes through verbatim
    build/artefacts.ts       codegen-manifest parse + per-path explanation (which generator,
                             what drove it); reads what was emitted, never predicts it
    caps/index.ts            caps-list_capabilities, caps-describe_composition — reads the
                             build-time cap-manifest.json of the user's own project; never
                             re-resolves the @Requires→@Provides DAG
    caps/shapes.ts           cap-manifest wire shapes + validators (CapManifest/Stamp/Module)
    bridge/index.ts          bridge-version, bridge-health — the bridge's own diagnostic
                             surface (never gated, never spawns)
  data/bundle.ts             reader for the bundled reference corpus — manifest parse,
                             per-entry SHA-256 verification, sandboxed to data/
scripts/
  vendor-reference-data.mjs  generates + verifies data/ at pack time (`prepack`)
  p2-smoke.mjs               zero-checkout smoke test — packs, installs and interrogates
                             the tarball on a scrubbed environment (CI job `p2-smoke`)
docs/
  adr/
    ADR-025-ai-agent-bridge.md   Founding ADR (authoritative copy — cross-repo per ADR-020)
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

This repo is consistently licensed with `exeris-kernel`, `exeris-sdk`, and `exeris-tooling`. Commercial protection of the ecosystem is enforced at the capability and SKU layer per [ADR-023](../exeris-docs/adr/ADR-023-capability-licensing-taxonomy.md), not at the agent-bridge layer.

## Where this repo fits

This is the twentieth active sibling repository in `~/exeris-systems/`. It is **not** a Tier 2 `exeris-caps-*` capability, **not** a Tier 3 `exeris-sku-*` product, and **not** part of the Tier 1 substrate. It is developer-facing tooling — structurally closer to `exeris-tooling` than to anything else in the map.

See the top-level [`~/exeris-systems/CLAUDE.md`](../CLAUDE.md) sub-repo map and the founding [ADR-025](docs/adr/ADR-025-ai-agent-bridge.md) for the full rationale.
