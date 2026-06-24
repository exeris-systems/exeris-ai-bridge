# exeris-ai-bridge

**Model Context Protocol server exposing Exeris ecosystem surfaces to AI agents.**

`exeris-ai-bridge` is a public, Apache 2.0 MCP server that publishes three surfaces from the Exeris ecosystem to AI agents (Claude Code, Cursor, Copilot Workspace, and any other MCP-aware client):

- **Studio / LSP bridge** — query `@ExerisDomain` types, action signatures, codegen artefacts from a running `exeris-platform-lsp` session.
- **Docs / ADR registry** — search and fetch ADRs, HLA, whitepaper, and templates from `exeris-docs`.
- **Kernel introspection** — read-only inspection of a running kernel's provider registry, bootstrap/subsystem DAG, and per-subsystem detail (via the `KernelDiagnostics` SPI). Cap-blind by design: capability composition is a build-time tooling/platform surface, not a kernel one (see [ADR-024](../exeris-docs/adr/ADR-024-capability-composition-model.md) 2026-06-17 amendment and ADR-025 §"`kernel:*` Is Cap-Blind").

The repo is named *bridge*, not *mcp*: MCP is the first protocol surface, but the mission is "bridge Exeris semantic surfaces to AI agents" — adjacent integrations (Claude Skills bundles, agent-SDK adapters, future protocols) live here when they share that responsibility.

See [`docs/adr/ADR-025-ai-agent-bridge.md`](docs/adr/ADR-025-ai-agent-bridge.md) for the founding decision.

## Status

**0.2.0 — `docs:*` family live; `lsp:*` bound to the companion `exeris/*` slice (0.3.0 Phase 3b).** ADR-025 ACCEPTED (2026-05-15). The full `docs:*` surface (9 tools) is implemented and filesystem-bound against `exeris-docs` — a Claude Code session can call `docs:list_adrs`, `docs:get_adr`, `docs:search`, and the per-repo docs tools end-to-end (see [Try it](#try-it-end-to-end)). The `lsp:*` family (3 tools) has its transport, server discovery, and resilient error model in place, and is now bound to the read-only `exeris/*` slice that shipped in `exeris-platform-lsp` (`feat/lsp-readonly-slice`): `lsp:list_domains` / `lsp:describe_domain` / `lsp:list_actions` call `exeris/domains` / `exeris/domainDescribe` / `exeris/actions` and validate each result against its wire shape. Platform reports the default `exec:java` launch works; the one remaining 0.3.0 item is a bridge-side integration test confirming the live data path end-to-end (see [`ROADMAP.md`](ROADMAP.md) §0.3.0). The `kernel:*` family (3 tools) remains a definition-only placeholder; its upstream contract (the `KernelDiagnostics` SPI + CLI) has shipped in `exeris-kernel` (v0.9.0, ADR-033), so it is now blocked only on the bridge-side adapter (`src/transport/kernel-adapter.ts`, 0.4.0).

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
      "args": ["/abs/path/to/exeris-ai-bridge/dist/server.js"],
      "env": {
        "EXERIS_DOCS_ROOT": "/abs/path/to/exeris-docs"
      }
    }
  }
}
```

`EXERIS_DOCS_ROOT` points at the `exeris-docs` checkout the `docs:*` tools read from. It is **optional when the bridge is cloned as a sibling of `exeris-docs`** under `~/exeris-systems/` (the default resolves `../exeris-docs` relative to the install) — set it explicitly for npm-installed or relocated deployments. The filesystem sandbox is anchored on this root and its sibling repos; the server refuses to read anything outside it.

`EXERIS_LSP_COMMAND` (optional) is how the `lsp:*` family launches its `exeris-platform-lsp` child — a whitespace-separated command + args (no shell quoting; the process is exec'd directly). It defaults to `mvn -q -f <ecosystemRoot>/exeris-platform/exeris-platform-lsp/pom.xml exec:java` (`-q` keeps Maven's own logging off the JSON-RPC stdout). The child is spawned lazily on the first `lsp:*` call and cached; its stderr is inherited into the bridge's logs. The companion `exeris/*` requests now exist, so `lsp:*` calls return validated data against a running server; a server build predating the slice still yields a structured "update the LSP server" result rather than failing. Platform reports the default `exec:java` launch keeps protocol frames clean on stdout (the app logs to stderr); the bridge-side integration test (ROADMAP §0.3.0) is the final confirmation.

For other MCP-aware clients, point at the same `node dist/server.js` invocation over stdio.

## Try it (end-to-end)

Once wired in, the bridge answers ecosystem-introspection questions directly from `exeris-docs`. A representative session — *"list all ADR-024-related context"*:

| Agent intent | Tool call | Returns |
|:---|:---|:---|
| Enumerate the registry | `docs:list_adrs` | structured rows `{ number, title, owningRepo, scope, visibility, status, link }[]` (optional `status` filter) |
| Read the decision in full | `docs:get_adr` `{ "number": 24 }` | the authoritative ADR-024 markdown body (`number` is an **integer**, padded forms like `024` are normalized) |
| Find every mention | `docs:search` `{ "query": "ADR-024", "maxResults": 5 }` | `{ path, line, snippet }[]` hits across the docs tree, with `truncated` / safety caps |

You can drive the same handshake without an agent — pipe newline-delimited JSON-RPC straight at the stdio server:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs:get_adr","arguments":{"number":24}}}' \
  | node dist/server.js
```

`tools/list` advertises all 15 tool definitions (9 live `docs:*`, plus the 3 `lsp:*` and 3 `kernel:*` placeholders); `tools/call` on `docs:get_adr` returns the ADR-024 body.

## Repo layout

```
src/
  server.ts                  MCP server entry, tool registry, stdio transport
  config/env.ts              EXERIS_DOCS_ROOT + EXERIS_LSP_COMMAND resolution, ecosystem-root derivation
  fs/sandbox.ts              path-sandbox guard — reads resolve under a pinned root
  transport/
    lsp-framing.ts           LSP base-protocol (Content-Length) message codec
    lsp-client.ts            JSON-RPC client over a child exeris-platform-lsp process
  tools/
    types.ts                 Shared ToolDefinition / ToolHandler types
    docs/
      index.ts               docs:* — 9 filesystem-bound tools (list/get ADRs, templates,
                             HLA, whitepaper, search, per-repo docs surface)
      adr-index.ts           parser for exeris-docs/adr-index.md
    lsp/index.ts             lsp:list_domains, lsp:describe_domain, lsp:list_actions — LSP proxy
                             (transport ready 0.3.0 Phase 3a; data path blocked on companion)
    kernel/index.ts          kernel:list_providers, kernel:get_bootstrap_dag, kernel:describe_subsystem
                             — diagnostic adapter (placeholder, 0.4.0; cap-blind — no list_capabilities)
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
