import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { BridgeConfig, ProjectConfig, Unavailable } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import { CapShapeError, parseCapManifest, type CapManifest } from "./shapes.js";

// caps:* — read-only introspection of the capability composition of the USER'S
// OWN project, sourced from the build-time manifest exeris-tooling emits.
//
// This family is the one the ADR-024 2026-06-17 "Validation Stamp Lifecycle"
// amendment pre-authorised, on two conditions the code here has to keep: it
// sources from BUILD-TIME artefacts and never from a running kernel, and it
// reads what the producer stamped rather than recomputing it. kernel:* stays
// cap-blind; there is no kernel-list_capabilities and this family is not a
// route to one.
//
// Scope discipline (ROADMAP 0.6.0): caps:* reads emitted manifests only. It
// does NOT re-resolve the @Requires→@Provides DAG. `initOrder` is transcribed
// from the manifest verbatim — exeris-tooling validates and stamps that order,
// and a second implementation here would disagree with it the first time
// either side changed.

/** Where exeris-tooling's codegen writes the manifest, relative to the project root. */
const MANIFEST_PATH = "src/main/generated/java/cap-manifest.json";

type CapsFamily = { readonly state: "available"; readonly project: ProjectConfig } | Unavailable;

export function registerCapsTools(config: BridgeConfig): RegisteredTool[] {
  const handle: CapsFamily =
    config.project.state === "available"
      ? { state: "available", project: config.project }
      : config.project;
  return [listCapabilitiesTool(handle), describeCompositionTool(handle)];
}

function listCapabilitiesTool(handle: CapsFamily): RegisteredTool {
  return {
    definition: {
      name: "caps-list_capabilities",
      description:
        "List the capability modules composed into this project, from the build-time cap-manifest.json: each module's qualified name, the services it provides with their versions, and which module owns the lifecycle. Also returns initOrder exactly as the manifest states it. A project with no capabilities returns an empty list, not an error.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("caps", handle, async ({ project }) =>
      withManifest(project, (manifest) =>
        manifest === null
          ? emptyAnswer()
          : jsonResult({
              schemaVersion: manifest.schemaVersion,
              modules: manifest.modules,
              initOrder: manifest.initOrder,
            }),
      ),
    ),
  };
}

function describeCompositionTool(handle: CapsFamily): RegisteredTool {
  return {
    definition: {
      name: "caps-describe_composition",
      description:
        "Report the composition stamp from cap-manifest.json: whether the capability graph validated, the composition version, and the content binding digest, alongside the manifest schema version, the module count and initOrder. Answers 'is this build's composition trustworthy, and which build is it'. A project with no capabilities returns a present:false answer, not an error.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("caps", handle, async ({ project }) =>
      withManifest(project, (manifest) =>
        manifest === null
          ? emptyAnswer()
          : jsonResult({
              present: true,
              schemaVersion: manifest.schemaVersion,
              stamp: manifest.stamp,
              moduleCount: manifest.modules.length,
              initOrder: manifest.initOrder,
            }),
      ),
    ),
  };
}

/**
 * Read + validate the manifest, or report its absence as an ANSWER.
 *
 * A project with no capabilities is the ordinary case in a user's own tree, and
 * it stays the ordinary case now that the producer has shipped — most
 * applications compose none. So "no manifest" resolves to a clean empty result
 * with `present: false`, never an error: an agent that has to distinguish "you
 * have no capabilities" from "something broke" cannot do it from an error
 * string, and would reasonably stop asking.
 */
function withManifest(
  project: ProjectConfig,
  render: (manifest: CapManifest | null) => ReturnType<typeof jsonResult>,
) {
  let raw: string;
  try {
    // The path is ours, not the agent's — no tool in this family takes one —
    // but it is still sandbox-checked against the pinned root. A generated
    // tree can carry a symlink, and "we built the string" is not containment.
    const resolved = resolveInside(project.projectRoot, join(project.projectRoot, MANIFEST_PATH));
    raw = readFileSync(resolved, "utf8");
  } catch (err) {
    // resolveInside raises SandboxEscapeError for BOTH "outside the root" and
    // "did not resolve on disk", deliberately, so callers get one error type.
    // Here the two need opposite answers, and `resolved` is the discriminator
    // the class exposes for exactly this: null means nothing was found (the
    // ordinary cap-less project, and also a dangling symlink — nothing was
    // read either way), non-null means a real path outside the root.
    if (err instanceof SandboxEscapeError && err.resolved !== null) {
      return errorResult(
        `${MANIFEST_PATH} resolves outside the project root (sandbox escape); refusing to read it.`,
      );
    }
    // Everything else — absent file, unreadable file — is "no manifest, no
    // capabilities", which is an answer rather than a failure.
    return render(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return errorResult(
      `${MANIFEST_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return render(parseCapManifest(parsed));
  } catch (err) {
    if (err instanceof CapShapeError) {
      return errorResult(
        `${MANIFEST_PATH} did not match the expected cap-manifest wire shape: ${err.message}`,
      );
    }
    throw err;
  }
}

/**
 * The cap-less answer. Both tools return the same `present: false` marker so an
 * agent branches on one field rather than on the absence of two different keys.
 */
function emptyAnswer() {
  return jsonResult({
    present: false,
    reason: "This project has no cap-manifest.json, so no capabilities are composed into it.",
    modules: [],
    initOrder: [],
  });
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
