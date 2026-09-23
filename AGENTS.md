---
title: "exeris-ai-bridge: the MCP server that publishes Exeris surfaces to AI agents"
type: reference
visibility: public
owning-repo: exeris-ai-bridge
status: active
last-verified: 2026-09-22
---

# exeris-ai-bridge: the MCP server that publishes Exeris surfaces to AI agents

The portable entry point for any AI agent working in this repository. It is an index and a safety
boundary: the detailed operating rules live in [`CLAUDE.md`](CLAUDE.md), the founding decision in
[ADR-025](docs/adr/ADR-025-ai-agent-bridge.md), and the reusable agent material under
[`.agents/`](.agents). Human-facing description is in [`README.md`](README.md).

## Mission and scope

`exeris-ai-bridge` is a Model Context Protocol server, written in TypeScript for Node 20+, that
publishes Exeris ecosystem surfaces to AI agents: the docs/ADR registry, the Studio/LSP bridge,
kernel introspection, and — for application developers without an ecosystem checkout — the SDK,
build and capability-manifest views of their own project. It is developer-facing tooling: not part
of the kernel substrate, not a capability, not a SKU.

## Operating contract

These are hard constraints. The reasoning behind each is in ADR-025 and in `CLAUDE.md`; this list
names them so no agent starts without them.

- **The Wall, by construction.** This process never links the Java kernel classpath. Kernel access
  crosses a process boundary (JSON over stdio to the `KernelDiagnostics` adapter) — no GraalVM,
  JNI or JNR.
- **No model API.** The bridge is the server side of MCP. No model SDK is a dependency and no model
  API key lives here.
- **Read-only, everywhere.** No tool mutates kernel state or writes into the user's project;
  `lsp-preview_mutation` returns a diff and the agent writes the file with its own tools.
- **Not a capability.** No `@Provides` / `@Requires`, no composition-manifest entry, no
  `exeris-caps-*` dependency on this repository.
- **Apache 2.0**, unchanged and unwrapped.
- **Filesystem reads stay inside a pinned root**, verified after resolution — including paths the
  bridge generated itself.
- **New tool families need an ADR-025 amendment** (or a successor ADR) before any code.
- **Zero-checkout stays bootable:** the server starts on a machine with no sibling repositories.

When sources disagree, ADR-025 wins, then the cross-repo ADRs in `exeris-systems/exeris-docs`, then
`CLAUDE.md`, then this file. English for every persisted artefact.

## Architecture and documentation entry points

- [ADR-025](docs/adr/ADR-025-ai-agent-bridge.md) — the founding decision and its amendments (tool
  families, the two personas, cap-blind `kernel:*`, preview-never-write). Read it first.
- [`CLAUDE.md`](CLAUDE.md) — strong defaults, scoped bans, the tool family table, the two personas,
  and when to consult ADR-006, ADR-020, ADR-023 and ADR-024.
- [`ROADMAP.md`](ROADMAP.md) — milestone scope.
- [`README.md`](README.md) — architecture diagram and client wiring.
- The ecosystem ADR registry is `adr-index.md` in `exeris-systems/exeris-docs`; this repository
  holds ADR-025 and a link stub for ADR-033.

## `.agents/` — the canonical agent material

Agent material is authored once, under [`.agents/`](.agents), and rendered for each provider.

| Path | What it holds |
|:--|:--|
| [`.agents/agents/`](.agents/agents) | Role profiles, one per directory as `<name>/AGENT.md`: router, architect, implementer, tool-family discipline, docs/ADR. |
| [`.agents/skills/`](.agents/skills) | Bounded capabilities: task classification, routing, and the four reviews — Wall / process boundary, read-only tool, path sandbox, tool-family purity. |
| [`.agents/workflows/`](.agents/workflows) | User-invoked checks: `/wall-process-boundary-check`, `/read-only-tool-check`, `/path-sandbox-check`, `/tool-family-purity`. |
| [`.agents/vendor/`](.agents/vendor) | The shared `exeris-agents` bundle, pinned and digest-verified. Its policies bind here and are composed as `bundle:<name>` — [agent safety and autonomy](.agents/vendor/exeris-agents-2.1.0/policies/agent-safety-and-autonomy.md), [error handling and fallback](.agents/vendor/exeris-agents-2.1.0/policies/error-handling-and-fallback.md). Never edited in place. |
| [`.agents/manifest.yaml`](.agents/manifest.yaml) | The composition, the pinned bundle, the render map, and what each provider cannot do. |

Start at `exeris-ai-bridge-router` when the right specialist is not obvious. Instruction sources
resolve broad to narrow — organisation bundle, repository, selected workflow — and a narrower file
may restrict behaviour but never relax a higher-order rule.

## Verification and reporting

Before a pull request: `npm run typecheck`, `npm run lint`, `npm test` (which builds first). If the
change touches config resolution, packaging (`files`, `bin`, `prepack`) or the launch ladder, also
`npm run smoke:p2` — the unit suite runs inside an ecosystem checkout and cannot see a
zero-checkout regression. A change to the agent material reruns `agents_file_check.py`,
`agents_render.py --check` and `agents_bundle.py verify` from `exeris-systems/exeris-agents`.

Report what ran and its result, and name what did not run as not run — silence is not a pass.

## Provider adapters

[`.claude/`](.claude) holds Claude Code adapters generated from `.agents/` by the shared renderer
in `exeris-systems/exeris-agents`, each carrying a do-not-edit marker naming its source, plus
provider-owned local configuration. Regenerate them; never edit them. The other provider
directories are deferred, and the manifest says so.
