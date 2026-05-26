# exeris-ai-bridge

**Model Context Protocol server exposing Exeris ecosystem surfaces to AI agents.**

`exeris-ai-bridge` is a public, Apache 2.0 MCP server that publishes three surfaces from the Exeris ecosystem to AI agents (Claude Code, Cursor, Copilot Workspace, and any other MCP-aware client):

- **Studio / LSP bridge** — query `@ExerisDomain` types, action signatures, codegen artefacts from a running `exeris-platform-lsp` session.
- **Docs / ADR registry** — search and fetch ADRs, HLA, whitepaper, and templates from `exeris-docs`.
- **Kernel introspection** — read-only inspection of a running kernel's provider registry, subsystem DAG, and capability composition (per [ADR-024](../exeris-docs/adr/ADR-024-capability-composition-model.md)).

The repo is named *bridge*, not *mcp*: MCP is the first protocol surface, but the mission is "bridge Exeris semantic surfaces to AI agents" — adjacent integrations (Claude Skills bundles, agent-SDK adapters, future protocols) live here when they share that responsibility.

See [`docs/adr/ADR-025-ai-agent-bridge.md`](docs/adr/ADR-025-ai-agent-bridge.md) for the founding decision.

## Status

**TRL-2 / Scaffold.** ADR-025 ACCEPTED (2026-05-15). Tool definitions exist; implementations land in follow-up PRs per the ADR's Engineering Protocol. The `kernel:*` tool family is additionally blocked on the `KernelDiagnostics` SPI RFC in `exeris-kernel`.

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

## Wiring into an agent

For Claude Code, add an entry to your `.claude/settings.json` MCP servers list:

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

For other MCP-aware clients, point at the same `node dist/server.js` invocation over stdio.

## Repo layout

```
src/
  server.ts                  MCP server entry, tool registry, stdio transport
  tools/
    types.ts                 Shared ToolDefinition / ToolHandler types
    docs/index.ts            docs:list_adrs, docs:get_adr — filesystem-bound
    lsp/index.ts             lsp:list_domains, lsp:describe_domain — LSP proxy
    kernel/index.ts          kernel:list_providers, kernel:list_capabilities — diagnostic adapter
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
