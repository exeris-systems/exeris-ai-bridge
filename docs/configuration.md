---
title: "Configuring exeris-ai-bridge"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-10-21
---

# Configuration reference

How `@exeris/ai-bridge` resolves its configuration. The short table is in the
[README](../README.md#configuration); this page states what each setting does and why.

## Resolution never fails

**Every `EXERIS_*` variable is optional, and none of them can stop the server from booting.** Config resolution never fails: a dependency that does not resolve disables its own family and leaves the rest running. The tool surface does not change — `tools/list` always advertises all 33 tools, because 1.0 freezes it under semver and clients cache it — but a call into a disabled family returns a structured `family_unavailable` result naming the reason and the remedy instead of a transport error. A one-line boot summary (`mode=… docs=… lsp=… kernel=… build=… caps=…`) goes to stderr, which MCP clients surface in their logs.

When something is dark, **`bridge-health` is the tool to call**. It reports the resolved mode, every family's state with its reason and remedy, and — for the two families backed by a child process — that process's current state, *without starting it*. For `sdk` it carries `versionSkew`, and for `build` it carries `toolingSkew`: `aligned`, `skew_detected` or `unknown` for the project's pinned tooling release (its `exeris-app-parent` or `exeris-codegen-maven-plugin` version, else the installed `@exeris/codegen-ts`) against the release the bundled generator catalogue was vendored from; `build-explain_artefacts` and `build-preview_generation` report the same value. `bridge-version` identifies the build the answer came from. Both are read-only, cost nothing, and are never themselves gated: a diagnostic that goes dark along with what it diagnoses would be worthless. Deliberately absent is a "probe" that spawns the children to check they launch — the families' own tools answer that by doing the real work, and the outcome then shows up in the next `bridge-health`.

## Tool names

**Tool names use `family-tool`, not `family:tool`.** The families are still namespaced — `docs:*`, `lsp:*`, `kernel:*`, `bridge:*` name the *family* throughout this repo and in ADR-025 — but the name that goes on the wire separates the two halves with a hyphen, because MCP clients do not reliably resolve a `:` in a tool name. Nothing else about the surface changed: the prefix still identifies the family, and `bridge-health` still reports per-family state under its family key.

## Instructions sent at connect time

**The server also ships `instructions`.** MCP delivers them in the `initialize` response, so the client can put them in front of the model *before* it calls anything — which is the only point at which a wrong architectural assumption is still cheap. They stay a route rather than a cheat sheet: what this server is, that every tool is a read, which family answers which question, the state each family resolved to in this session, and one correction that an agent trained mostly on Spring needs first — Exeris has no Spring context, no DI container, and no JPA or Hibernate anywhere in the kernel, SDK or build tooling. Framework facts themselves stay in the documents the tools serve; copied into the instructions they would be a second, unversioned copy that drifts.

## Project root

`EXERIS_PROJECT_ROOT` points at **the developer's own project** — the tree `build:*` and `caps:*` report on. It is optional: with nothing set, the bridge walks up from its working directory to the nearest `pom.xml`, which is the right answer when an agent starts the server inside the project it is working on, and lands on the owning module rather than the aggregator in a multi-module build. Set it explicitly when the agent's working directory is somewhere else. An explicit root is taken as given and is **not** required to contain a `pom.xml` — naming it is how you escape our guessing. Reads are sandboxed to this root exactly as `docs:*` reads are sandboxed to the docs root, including for paths the bridge builds itself.

## Mode

`EXERIS_BRIDGE_MODE` (optional, `app` | `contributor`, default `app`) says which persona the bridge serves. **The default is the application developer, and contributor mode is chosen, never inferred**: a checkout next to the install does not switch it, because an application developer may well clone `exeris-docs` to read it. The one thing the mode changes is which launch rung wins (below). It is otherwise **descriptive, not a mask**: pinning `app` does not hide `docs:*` when the docs checkout is present, because availability has exactly one source of truth (did the dependency resolve). What pinning `contributor` does buy you is a louder failure — missing roots are then reported as a misconfiguration rather than as the ordinary application-developer state.

## Docs root and the registry snapshot

`EXERIS_DOCS_ROOT` points at the `exeris-docs` checkout the `docs:*` tools read from. It is **optional when the bridge is cloned as a sibling of `exeris-docs`** under `~/exeris-systems/` (the default resolves `../exeris-docs` relative to the install) — set it explicitly for npm-installed or relocated deployments. The filesystem sandbox is anchored on this root and its sibling repos; the server refuses to read anything outside it. With no checkout to resolve, `docs:*` answers from the **registry snapshot bundled in the published package**: `adr-index.md`, every public record it links from a repository whose licence permits redistribution, the HLA, the whitepaper and the templates, read from each repository's default branch when the package was packed (`data/docs/NOTICE.md` lists the commits and licences). `bridge-health` reports which source answered. The per-repository tools (`docs-list_repos`, `docs-list_repo_docs`, `docs-get_repo_doc`) need a checkout, and a record from a repository the snapshot leaves out answers with its GitHub URL. An `EXERIS_DOCS_ROOT` that is set but does not resolve takes `docs:*` dark rather than falling back to the snapshot.

## Launching the Java children

Both child-process families resolve their launch spec through a **ladder**, first hit wins, nothing on it touches the network:

| rung | how | `source` in `bridge-health` |
| --- | --- | --- |
| 1 | `EXERIS_LSP_COMMAND` / `EXERIS_KERNEL_COMMAND` — a full command line | `env-command` |
| 2 | `EXERIS_LSP_JAR` / `EXERIS_KERNEL_JAR` — a jar you already have | `env-jar` |
| 3 | a published jar in your local Maven repository, by coordinate | `m2` |
| 4 | `mvn exec:java` against the sibling module, if its pom is there | `source-tree` |

Rungs 3 and 4 **swap order by mode**: in contributor mode the source tree wins, because someone with the checkout is working *on* that tree and a released jar would quietly answer for code they are not editing; in app mode the published jar wins. That is preference, not gating — whichever is second still fires when the first cannot.

Rung 3 finds the local repository at `EXERIS_MAVEN_REPO`, then `<localRepository>` in `~/.m2/settings.xml`, then `~/.m2/repository`. The version is the newest **release** of the anchor artifact present there (`exeris-kernel-core` for the kernel CLI) — not the version your project's dependency graph resolves, which would require a Maven invocation on the boot path. `EXERIS_KERNEL_VERSION` pins it when those differ. Jar launches use `$JAVA_HOME/bin/java` when `JAVA_HOME` is set, else `java`; rung 1 is the escape hatch when you need something else. `lsp:*` has no rung 3 yet: the published `exeris-platform-lsp` jar carries no `Main-Class`, so probing for it would produce a launch that fails at startup.

### `lsp-*`

`EXERIS_LSP_COMMAND` (optional) is how the `lsp:*` family launches its `exeris-platform-lsp` child — a whitespace-separated command + args (no shell quoting; the process is exec'd directly). The source-tree rung runs `mvn -q -f <ecosystemRoot>/exeris-platform/exeris-platform-lsp/pom.xml exec:java` (`-q` keeps Maven's own logging off the JSON-RPC stdout). The child is spawned lazily on the first `lsp:*` call and cached; its stderr is inherited into the bridge's logs. `lsp:*` calls return validated data against a running server; a server build predating the `exeris/*` slice yields a structured "update the LSP server" result rather than failing. The integration test confirms the default `exec:java` launch keeps protocol frames clean on stdout (the JVM logs to stderr), so no `exec:exec` workaround is needed.

`EXERIS_LSP_WORKSPACE` (optional) is the workspace root the LSP server indexes for `@ExerisDomain` sources, sent as `rootUri` in the `initialize` handshake. It defaults to the bridge's working directory (the project it was spawned in). With no resolvable workspace the server returns an empty index, so `lsp:*` tools answer `[]`. Set it explicitly: the working directory an MCP host gives a server is often `/` or the home directory, which is neither a project nor safe to watch. The bridge watches the workspace root so the server notices writes by other processes (a checkout, an IDE, another language server); it refuses to watch a filesystem root or the home directory, skips `.git`, `node_modules`, `dist`, `target` (except `generated-sources`) and `build` (except `generated`), and stops after 10 000 directories. In each of those cases the watch is `degraded` in `bridge-health` and the bridge instead tells the server to rescan before every `lsp-*` request, so answers stay current at the cost of a rescan per call.

### `kernel-*`

`EXERIS_KERNEL_COMMAND` (optional) is how the `kernel:*` family launches its `exeris-kernel-diagnostics-cli` child — a whitespace-separated command + args (no shell quoting; exec'd directly), spawned lazily on the first `kernel:*` call and cached. It defaults to `mvn -q -f <ecosystemRoot>/exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml exec:java -Dexec.mainClass=eu.exeris.kernel.diagnostics.cli.DiagnosticsCli` (`-q` keeps Maven's logging off the NDJSON stdout; the CLI logs to stderr, which is inherited into the bridge's logs). The CLI boots the kernel in **read-only inspect mode** and speaks newline-delimited JSON; the bridge correlates responses FIFO and validates each snapshot against its `KernelDiagnostics` wire shape. A pre-built shaded jar is the faster override, and **from kernel 0.11.0 it needs no special flags**: `EXERIS_KERNEL_COMMAND="java -jar /abs/…/exeris-kernel-diagnostics-cli-<ver>.jar"`. The kernel went preview-clean at 0.11.0 (ADR-066: "the DISTRIBUTED artifact is preview-clean" — preview is now bound to test-compile and surefire only), and the published jars put the boundary exactly there: `0.10.2` has 12 preview-stamped classes out of 799, `0.11.0` has 0 out of 897. On an **older** jar you need `java --enable-preview -jar …` and the JDK it was built on; the JVM says so itself (`UnsupportedClassVersionError: Preview features are not enabled … Try running with '--enable-preview'`) and the bridge passes that message through. The same jar is published, so the path may equally be a local Maven repo coordinate — which is what the ladder's `m2` rung resolves for you.

> The diagnostics CLI boots the kernel in **read-only inspect mode** and speaks NDJSON over stdio; responses correlate FIFO and validate against the `KernelDiagnostics` wire shapes. In zero-checkout mode it launches as the shaded jar `eu.exeris:exeris-kernel-diagnostics-cli:0.12.0` through the ladder's `m2` rung as plain `java -jar` — the published jar is preview-clean, so no `--enable-preview` — or through an explicit `EXERIS_KERNEL_COMMAND`. If the CLI is not found or fails to start, `kernel:*` calls return a structured `family_unavailable` result rather than crashing.

## Bundled reference data

The published package carries a small read-only corpus so an application developer with **no ecosystem checkout and no network** still gets grounded answers. It is generated at pack time by `scripts/vendor-reference-data.mjs`, and `data/` is deliberately **not committed** — which means a bridge run from a source checkout has no bundle, and reports that plainly rather than pretending.

`bridge-version` reports which state you are in:

```jsonc
"bundle": { "state": "unavailable", "reason": "No bundled reference data is present…", "remedy": "…run npm run vendor:data…" }
"bundle": { "state": "available", "generatedAt": "…", "bridgeVersion": "0.8.0", "entryCount": 4, "sourceArtifacts": ["eu.exeris:exeris-sdk-annotations:0.12.0", "eu.exeris:exeris-sdk-source-model:0.12.0", "eu.exeris:exeris-codegen-java:0.10.0", "eu.exeris:exeris-app-bom:0.10.0"] }
```

The bundle ships with the **annotation catalog and AST schema** (from the released `exeris-sdk` jars), the **generator catalogue** (from the released `exeris-codegen-java` jar) and the **application starter** (the tested tooling + kernel + SDK triple, from the released `exeris-app-bom`, `exeris-app-parent` and `exeris-app-starter` POMs at `EXERIS_TOOLING_VERSION`; `build-get_starter` reads it), all generated at prepack time. Every entry carries a SHA-256 that is verified on each read (a truncated file parses fine and is quietly wrong) and a `sourceArtifact` coordinate, so an answer can say which upstream release it reflects.
