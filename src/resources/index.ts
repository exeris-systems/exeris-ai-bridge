import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import { DOCS_RESOURCE_TEMPLATES, DOCS_RESOURCES, readDocsResource } from "./docs.js";

/**
 * Wire the resource handlers onto `server`, which must advertise the
 * `resources` capability. The lists are constants, so they are identical in
 * every mode and every environment.
 */
export function registerResources(server: Server, config: BridgeConfig): void {
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [...DOCS_RESOURCES],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [...DOCS_RESOURCE_TEMPLATES],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
    contents: readDocsResource(config.docs, request.params.uri),
  }));
}
