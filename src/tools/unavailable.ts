import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolFamily, Unavailable } from "../config/env.js";
import type { ToolHandler } from "./types.js";

// Family availability, applied at the handler — never at the registry.
//
// Every tool DEFINITION is built unconditionally, so tools/list is byte-identical
// on a full ecosystem checkout and on a bare application project. That is a
// requirement, not a convenience: 1.0 freezes the tool surface under semver and
// MCP clients cache the list at connect time, so a surface that varied with the
// environment could not be frozen and would leave a client holding a stale list.
//
// What varies is the RESULT. A dark family answers every call with the reason
// and remedy config resolution already worked out, instead of failing later at
// spawn time with a transport error that cannot say what to do about it.

/**
 * Marker every "this family is live" handle carries, so guard() can
 * discriminate against Unavailable without each family inventing its own flag.
 */
export interface Available {
  readonly state: "available";
}

/**
 * Bind a tool handler to its family's availability.
 *
 * When the family resolved, `handle` is passed through to the handler — the
 * docs roots, the LSP client, the kernel adapter. When it did not, the handler
 * is never invoked and every call returns the structured dark result.
 */
export function guard<T extends Available>(
  family: ToolFamily,
  handle: T | Unavailable,
  handler: (handle: T, args: Record<string, unknown>) => Promise<CallToolResult>,
): ToolHandler {
  if (handle.state === "unavailable") {
    return async () => unavailableResult(family, handle);
  }
  return async (args) => handler(handle, args);
}

/**
 * The agent-facing rendering of a dark family.
 *
 * JSON rather than prose, because this is a programmatic condition an agent
 * should branch on — stop calling the family, relay the remedy to the human —
 * unlike the runtime failures the handlers render as sentences. `isError` is
 * set so a client that only inspects the flag still treats it as a failure.
 *
 * Carries no absolute paths: `reason` and `remedy` are built under that
 * constraint at config-resolution time (see Unavailable).
 */
export function unavailableResult(family: ToolFamily, status: Unavailable): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "family_unavailable",
            family,
            message: `The ${family}:* tool family is not available in this environment.`,
            reason: status.reason,
            remedy: status.remedy,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}
