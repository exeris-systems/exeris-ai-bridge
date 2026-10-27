# @exeris/ai-bridge

> Model Context Protocol server that gives AI agents the context of an Exeris application: what
> your build emitted, the SDK's authoring contract, the ADR registry, and a running kernel.

Every tool is a read. The bridge never writes to your project, never calls a model API, and runs
as a separate process from the Java kernel. It is built for developers writing an application on
Exeris, and works without a checkout of the ecosystem: the reference data it needs ships inside
the package.

## Installation

Run the server inside your project, so it finds your `pom.xml`.

**Claude Code**

```sh
claude mcp add exeris -- npx -y @exeris/ai-bridge
```

**Claude Desktop**: install `exeris-ai-bridge-<version>.mcpb` from the
[GitHub Releases](https://github.com/exeris-systems/exeris-ai-bridge/releases). Desktop does not
start the server inside a project, so set **Project root** in the extension's settings to use the
`build-*` and `caps-*` tools.

**Any other MCP client** (Cursor, VS Code, Copilot): the command is `npx -y @exeris/ai-bridge`
over stdio.

```json
{
  "mcpServers": {
    "exeris": { "command": "npx", "args": ["-y", "@exeris/ai-bridge"] }
  }
}
```

The server is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.exeris-systems/ai-bridge`.

## Requirements

- Node 20 or newer.
- `kernel-*` only: JDK 25 or newer, and `eu.exeris:exeris-kernel-diagnostics-cli` in your local
  Maven repository, which a build of an Exeris application puts there.
- No network at run time. The bridge reads artefacts already in `~/.m2` and never downloads.

## Tools

Tool names are `family-tool`. All 33 are listed in every session; a family whose dependency is
missing answers with a structured `family_unavailable` result naming the reason and the remedy.

| Family | Answers | Tools |
| --- | --- | --- |
| `build-*` | What your last build emitted, which files codegen owns, what a build diagnostic means, and the build files for a new application, what the generator would write now; whether your project pins a different tooling release than the bundled generator catalogue (`toolingSkew`) | `build-list_domains`, `build-get_domain_metadata`, `build-explain_artefacts`, `build-get_detach_state`, `build-explain_diagnostic`, `build-get_starter`, `build-preview_generation` |
| `caps-*` | The capability composition your build validated | `caps-list_capabilities`, `caps-describe_composition` |
| `sdk-*` | The SDK's annotations, deprecations, scoping rules and AST schema; whether your project pins a different SDK | `sdk-list_annotations`, `sdk-describe_annotation`, `sdk-list_deprecations`, `sdk-get_scoping_rules`, `sdk-get_ast_schema` |
| `docs-*` | The Exeris ADRs, the high-level architecture, the whitepaper and the decision templates | `docs-list_adrs`, `docs-get_adr`, `docs-search`, `docs-get_hla`, `docs-get_whitepaper`, `docs-get_template`, `docs-list_repos`, `docs-list_repo_docs`, `docs-get_repo_doc` |
| `kernel-*` | A running kernel's providers, bootstrap DAG, subsystems and JVM ergonomics | `kernel-list_providers`, `kernel-get_bootstrap_dag`, `kernel-describe_subsystem`, `kernel-get_jvm_ergonomics` |
| `lsp-*` | `@ExerisDomain` types and actions from the Studio language server, and a preview of a source edit as a diff | `lsp-list_domains`, `lsp-describe_domain`, `lsp-list_actions`, `lsp-preview_mutation` |
| `bridge-*` | The server itself: version, bundled data, and why a family is unavailable | `bridge-version`, `bridge-health` |

`docs-list_repos`, `docs-list_repo_docs` and `docs-get_repo_doc` need a checkout of the Exeris
repositories; the other `docs-*` tools answer from a registry snapshot bundled in the package.
`lsp-*` needs a locally built `exeris-platform-lsp`, which publishes no runnable jar yet.

## Configuration

Nothing needs setting for an application. Every variable is optional, and none can stop the server
from booting.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXERIS_PROJECT_ROOT` | nearest `pom.xml` above the working directory | The project `build-*`, `caps-*` and `sdk-*` report on |
| `EXERIS_MAVEN_REPO` | `<localRepository>` in `~/.m2/settings.xml`, then `~/.m2/repository` | Where published jars are looked up |
| `EXERIS_KERNEL_VERSION` | newest release in the local repository | The diagnostics CLI version to launch |
| `EXERIS_KERNEL_COMMAND` / `EXERIS_KERNEL_JAR` | resolved from the local repository | Launch the kernel diagnostics CLI explicitly |
| `EXERIS_LSP_COMMAND` / `EXERIS_LSP_JAR` | none | Launch `exeris-platform-lsp` |
| `EXERIS_LSP_WORKSPACE` | the working directory | The workspace the language server indexes |
| `EXERIS_DOCS_ROOT` | the bundled snapshot | An `exeris-docs` checkout to read instead |
| `EXERIS_BRIDGE_MODE` | `app` | `contributor` for work on Exeris itself: source checkouts win over published jars |

How each variable resolves, the launch ladder for the Java children, and the bundled reference
data are described in the
[configuration reference](docs/configuration.md).

## Troubleshooting

Call `bridge-health`. It reports every family's state, with the reason and the remedy for each
one that is unavailable, without starting any child process. `bridge-version` reports the build
and the upstream releases its bundled data came from. The server also writes a one-line summary
(`mode=… docs=… lsp=… kernel=… build=… caps=…`) to stderr, which MCP clients show in their logs.

## Versioning

The package follows semver. Until 1.0, a minor release may change a tool's output shape; the
release notes list every change a client may notice. At 1.0 the tool names and input schemas are
frozen.

0.8.0 targets `exeris-kernel` 0.12.0, `exeris-sdk` 0.12.0 and `exeris-tooling` 0.10.0, all on Maven
Central.

## Links

- [Source](https://github.com/exeris-systems/exeris-ai-bridge)
- [Roadmap](ROADMAP.md)
- [Configuration reference](docs/configuration.md)
- [Contributing](CONTRIBUTING.md)
- [ADR-025, the founding decision](docs/adr/ADR-025-ai-agent-bridge.md)
- [Issues](https://github.com/exeris-systems/exeris-ai-bridge/issues)

## License

Apache-2.0
