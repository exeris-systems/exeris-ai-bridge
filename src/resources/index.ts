import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import type { BundleState } from "../data/bundle.js";
import { DOCS_RESOURCE_TEMPLATES, DOCS_RESOURCES, readDocsResource } from "./docs.js";
import { BRIEF_SCHEMA_URI, listSdkResources, readBriefSchemaResource } from "./sdk.js";
import {
  createAdrIndexSubscriptions,
  type AdrIndexSubscriptionOptions,
  type SubscriptionWatchStatus,
} from "./subscriptions.js";

export interface ResourcesOptions extends AdrIndexSubscriptionOptions {
  /** Bundle root the SDK resources read from; injectable for tests. */
  readonly bundleRoot?: string;
}

export interface ResourcesHandle {
  /** What a subscription to the registry index does right now, for bridge-health. */
  subscriptionWatch(): SubscriptionWatchStatus;
}

/**
 * Wire the resource handlers onto `server`, which must advertise the
 * `resources` capability with `subscribe`. The docs lists are constants, so they
 * are identical in every mode and every environment; the SDK resources are
 * listed only when `bundle` carries them. Subscription state belongs to this
 * server and ends when it closes.
 */
export function registerResources(
  server: Server,
  config: BridgeConfig,
  bundle: BundleState,
  options: ResourcesOptions = {},
): ResourcesHandle {
  const subscriptions = createAdrIndexSubscriptions(
    config.docs,
    (uri) => {
      server.sendResourceUpdated({ uri }).catch(() => {
        // A closed transport ends the subscription with the session.
      });
    },
    options,
  );
  const previousOnClose = server.onclose;
  server.onclose = () => {
    subscriptions.close();
    previousOnClose?.();
  };

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [...DOCS_RESOURCES, ...listSdkResources(bundle)],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [...DOCS_RESOURCE_TEMPLATES],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
    contents:
      request.params.uri === BRIEF_SCHEMA_URI
        ? readBriefSchemaResource(bundle, options.bundleRoot)
        : readDocsResource(config.docs, request.params.uri),
  }));

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    await subscriptions.subscribe(request.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscriptions.unsubscribe(request.params.uri);
    return {};
  });

  return { subscriptionWatch: () => subscriptions.status() };
}
