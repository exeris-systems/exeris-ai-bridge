import type { BridgeConfig, Unavailable } from "../../config/env.js";
import {
  KernelAdapter,
  KernelRequestError,
  KernelTransportError,
} from "../../transport/kernel-adapter.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import {
  KernelShapeError,
  parseBootstrapDagSnapshot,
  parseProvidersSnapshot,
  parseSubsystemSnapshot,
} from "./shapes.js";

// kernel:* — read-only introspection of a running Exeris kernel via the
// KernelDiagnostics SPI, reached through a child exeris-kernel-diagnostics-cli
// process over NDJSON (see ../../transport/kernel-adapter.ts). Crossing that
// process boundary is what preserves The Wall (ADR-006) by construction.
//
// Scope: runtime kernel state ONLY — provider registry, bootstrap/subsystem
// DAG, per-subsystem detail. This family is cap-blind: capability composition
// is a build-time tooling/platform surface, NOT a kernel one (ADR-024 2026-06-17
// "Validation Stamp Lifecycle" amendment; ADR-025 "kernel:* Is Cap-Blind"
// amendment). Do NOT add a kernel:list_capabilities tool here — if composition
// is ever surfaced it sources from exeris-tooling build artefacts and/or the
// exeris-platform composition runtime, never the kernel, and needs its own
// ADR-025 amendment first.
//
// Every tool is read-only: the SPI is read-only by design and the bridge never
// sends a mutating request (ADR-025 §"no mutation of kernel state").

const METHOD_LIST_PROVIDERS = "listProviders";
const METHOD_BOOTSTRAP_DAG = "getBootstrapDag";
const METHOD_DESCRIBE_SUBSYSTEM = "describeSubsystem";

/**
 * The kernel:* family handle: an adapter bound to a launch spec, or the
 * structured reason the family is dark. Every tool definition below is built
 * either way — only the handlers are gated (see ../unavailable.ts).
 */
type KernelFamily = { readonly state: "available"; readonly adapter: KernelAdapter } | Unavailable;

export function registerKernelTools(
  config: BridgeConfig,
  adapterOverride?: KernelAdapter,
): RegisteredTool[] {
  // One adapter per CLI process, shared across the family. Construction is
  // cheap and does NOT spawn — the child starts lazily on the first request.
  // An injected adapter IS a transport, so it overrides config-time
  // unavailability: the test seam must not depend on the environment.
  const handle = resolveKernelFamily(config, adapterOverride);
  return [listProvidersTool(handle), getBootstrapDagTool(handle), describeSubsystemTool(handle)];
}

function resolveKernelFamily(config: BridgeConfig, adapterOverride?: KernelAdapter): KernelFamily {
  if (adapterOverride !== undefined) {
    return { state: "available", adapter: adapterOverride };
  }
  if (config.kernel.state === "unavailable") {
    return config.kernel;
  }
  return { state: "available", adapter: new KernelAdapter(config.kernel) };
}

function listProvidersTool(handle: KernelFamily): RegisteredTool {
  return {
    definition: {
      name: "kernel-list_providers",
      description:
        "List all SPI providers registered with the running kernel, including driver origin (community/enterprise priority).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("kernel", handle, async ({ adapter }) =>
      callKernel(adapter, METHOD_LIST_PROVIDERS, undefined, parseProvidersSnapshot),
    ),
  };
}

function getBootstrapDagTool(handle: KernelFamily): RegisteredTool {
  return {
    definition: {
      name: "kernel-get_bootstrap_dag",
      description:
        "Snapshot of the kernel bootstrap dependency DAG — nodes (subsystems) with their phase, declared dependencies, and running state.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("kernel", handle, async ({ adapter }) =>
      callKernel(adapter, METHOD_BOOTSTRAP_DAG, undefined, parseBootstrapDagSnapshot),
    ),
  };
}

function describeSubsystemTool(handle: KernelFamily): RegisteredTool {
  return {
    definition: {
      name: "kernel-describe_subsystem",
      description:
        "Detail for a single kernel subsystem by name (e.g. memory, crypto, persistence, graph, transport, events, flow, http, security).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Subsystem name to describe." },
        },
        required: ["name"],
      },
    },
    handler: guard("kernel", handle, async ({ adapter }, args) => {
      const name = args.name;
      if (typeof name !== "string" || name.trim().length === 0) {
        return errorResult("Invalid input: 'name' must be a non-empty string");
      }
      return callKernel(adapter, METHOD_DESCRIBE_SUBSYSTEM, { name }, parseSubsystemSnapshot);
    }),
  };
}

/**
 * Run a single diagnostics request, validate the response against its wire
 * shape, and render it as a tool result — mapping the adapter's typed failures
 * and any shape mismatch onto actionable agent-facing messages.
 */
async function callKernel<T>(
  adapter: KernelAdapter,
  method: string,
  params: Record<string, unknown> | undefined,
  parse: (result: unknown) => T,
) {
  let result: unknown;
  try {
    result = await adapter.request(method, params);
  } catch (err) {
    if (err instanceof KernelRequestError) {
      return errorResult(`Kernel diagnostics request '${method}' was rejected: ${err.message}`);
    }
    if (err instanceof KernelTransportError) {
      return errorResult(
        `${err.message}. Set EXERIS_KERNEL_COMMAND to point at a runnable ` +
          `exeris-kernel-diagnostics-cli, or start the kernel diagnostics CLI manually; see README.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected kernel error on '${method}': ${message}`);
  }
  try {
    return ok(JSON.stringify(parse(result), null, 2));
  } catch (err) {
    if (err instanceof KernelShapeError) {
      return errorResult(
        `The kernel diagnostics response to '${method}' did not match the expected ` +
          `read-only wire shape: ${err.message}. The bridge and the kernel CLI may be on ` +
          `mismatched KernelDiagnostics schema versions.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to parse the '${method}' response: ${message}`);
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
