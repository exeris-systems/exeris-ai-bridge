#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type BridgeConfig } from "./config/env.js";
import { registerBridgeTools } from "./tools/bridge/index.js";
import { registerDocsTools } from "./tools/docs/index.js";
import { registerLspTools } from "./tools/lsp/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import type { ToolDefinition, ToolHandler } from "./tools/types.js";
import { KernelAdapter } from "./transport/kernel-adapter.js";
import { LspClient } from "./transport/lsp-client.js";
import { getServerVersion } from "./version.js";

const SERVER_NAME = "exeris-ai-bridge";

async function main(): Promise<void> {
  // Never throws: a family whose dependency did not resolve is dark, not fatal
  // (src/config/env.ts). The server boots on a machine with no ecosystem
  // checkout at all — that is the P2 contract, not a degraded mode.
  const config = loadConfig();
  process.stderr.write(bootSummary(config));

  // The child-process transports are built here rather than inside each family
  // registry, so bridge:health reports on the SAME instances the families use —
  // a separate instance would report a state nothing else ever reaches.
  // Construction does not spawn; the child starts lazily on the first request.
  // A dark family gets `undefined`, which leaves the registry's own dark path
  // intact: an injected transport is exactly what overrides config-time
  // unavailability, so handing one in here would wrongly light the family up.
  const lsp = config.lsp.state === "available" ? new LspClient(config.lsp) : undefined;
  const kernel = config.kernel.state === "available" ? new KernelAdapter(config.kernel) : undefined;

  const tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  for (const tool of [
    ...registerDocsTools(config),
    ...registerLspTools(config, lsp),
    ...registerKernelTools(config, kernel),
    ...registerBridgeTools(config, { lsp, kernel }),
  ]) {
    tools.set(tool.definition.name, tool);
  }

  const server = new Server(
    { name: SERVER_NAME, version: getServerVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.values()].map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    return await tool.handler(request.params.arguments ?? {});
  });

  await server.connect(new StdioServerTransport());
}

/**
 * One stderr line naming the mode and which families are live. MCP clients
 * surface a server's stderr in their logs, so this is the cheapest answer to
 * "why did docs:* say it was unavailable" — and stderr is the only channel
 * available, stdout being the MCP transport.
 */
function bootSummary(config: BridgeConfig): string {
  const families = (["docs", "lsp", "kernel"] as const)
    .map((family) => `${family}=${config[family].state}`)
    .join(" ");
  return `[exeris-ai-bridge] mode=${config.mode} (${config.modeSource}) ${families}\n`;
}

main().catch((err) => {
  console.error("[exeris-ai-bridge] fatal:", err);
  process.exit(1);
});
