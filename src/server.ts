#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type BridgeConfig } from "./config/env.js";
import { registerDocsTools } from "./tools/docs/index.js";
import { registerLspTools } from "./tools/lsp/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import type { ToolDefinition, ToolHandler } from "./tools/types.js";
import { getServerVersion } from "./version.js";

const SERVER_NAME = "exeris-ai-bridge";

async function main(): Promise<void> {
  // Never throws: a family whose dependency did not resolve is dark, not fatal
  // (src/config/env.ts). The server boots on a machine with no ecosystem
  // checkout at all — that is the P2 contract, not a degraded mode.
  const config = loadConfig();
  process.stderr.write(bootSummary(config));

  const tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  for (const tool of [
    ...registerDocsTools(config),
    ...registerLspTools(config),
    ...registerKernelTools(config),
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
