import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import type { BundleState } from "../data/bundle.js";
import { authorDomain } from "./author-domain.js";
import { diagnoseBuildFailure } from "./diagnose-build-failure.js";
import { draftAdr } from "./draft-adr.js";
import { explainMyBuild } from "./explain-my-build.js";
import { migrateSdkVersion } from "./migrate-sdk-version.js";
import { reviewThreeTierViolations } from "./review-three-tier-violations.js";
import { routeThisTask } from "./route-this-task.js";
import { toListedPrompt, type PromptDefinition } from "./types.js";
import { wallAudit } from "./wall-audit.js";

// Stateless prompt templates (ADR-025, 2026-10-27 amendment). prompts/get
// returns messages built from the template and the arguments given and nothing
// else: no session state, no loop, no model call, no tool call, no process and
// no network. A prompt that needs a tool says so in its text and the agent calls
// it. Nothing in this directory may import child_process, net or http; a test
// holds that.
//
// The list is a constant, so it is identical on every transport and in every
// mode, for the reason tools/list is: a client caches it at connect time and the
// surface is frozen under semver. Whether a prompt can pre-load its context is
// answered by prompts/get, in the messages it returns.

export const PROMPTS: readonly PromptDefinition[] = [
  reviewThreeTierViolations,
  draftAdr,
  routeThisTask,
  wallAudit,
  authorDomain,
  explainMyBuild,
  diagnoseBuildFailure,
  migrateSdkVersion,
];

/**
 * Wire the prompt handlers onto `server`, which must advertise the `prompts`
 * capability. `bundle` is the SDK data the server loaded at boot, the same
 * instance the sdk-* tools read; `bundleRoot` overrides where its files are read from.
 */
export function registerPrompts(server: Server, config: BridgeConfig, bundle: BundleState, bundleRoot?: string): void {
  const byName = new Map(PROMPTS.map((p) => [p.name, p]));

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: PROMPTS.map(toListedPrompt),
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const definition = byName.get(request.params.name);
    if (definition === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown prompt "${truncate(request.params.name)}". Expected one of: ${PROMPTS.map((p) => p.name).join(", ")}.`,
      );
    }
    const args = validateArguments(definition, request.params.arguments ?? {});
    return definition.render({ config, bundle, bundleRoot }, args);
  });
}

function validateArguments(
  definition: PromptDefinition,
  given: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const known = new Set(definition.arguments.map((a) => a.name));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Prompt ${definition.name} has no argument "${truncate(name)}".` +
          (known.size > 0 ? ` Arguments: ${[...known].join(", ")}.` : " It takes no arguments."),
      );
    }
  }

  const out: Record<string, string> = {};
  for (const spec of definition.arguments) {
    const value = given[spec.name];
    if (value === undefined) {
      if (spec.required) {
        throw new McpError(ErrorCode.InvalidParams, `Prompt ${definition.name} requires the argument "${spec.name}".`);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new McpError(ErrorCode.InvalidParams, `Argument "${spec.name}" must be a string.`);
    }
    if (value.length > spec.maxLength) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Argument "${spec.name}" is ${value.length} characters; the limit is ${spec.maxLength}.`,
      );
    }
    if (spec.pattern !== undefined && value !== "" && !spec.pattern.test(value)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Argument "${spec.name}" is not accepted: ${spec.patternHint ?? "it does not match the expected form"}.`,
      );
    }
    if (spec.required && value.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${definition.name} requires a non-empty "${spec.name}".`);
    }
    out[spec.name] = value;
  }
  return out;
}

function truncate(value: string): string {
  return value.length > 64 ? `${value.slice(0, 64)}...` : value;
}
