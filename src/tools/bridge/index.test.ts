import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig, KernelConfig, LspConfig, Unavailable } from "../../config/env.js";
import { KernelAdapter, type KernelChannel } from "../../transport/kernel-adapter.js";
import { LspClient, LspTransportError, type LspChannel, type LspCloseReason } from "../../transport/lsp-client.js";
import type { BundleState } from "../../data/bundle.js";
import { getServerVersion } from "../../version.js";
import { registerBridgeTools } from "./index.js";

function dark(family: string): Unavailable {
  return { state: "unavailable", reason: `${family} reason`, remedy: `${family} remedy` };
}

const LSP_SPEC: LspConfig = {
  state: "available",
  command: "lsp-stub",
  args: [],
  source: "source-tree",
  workspaceRoot: "/var/empty",
};

const KERNEL_SPEC: KernelConfig = {
  state: "available",
  command: "kernel-stub",
  args: [],
  source: "env-command",
};

const LIVE: BridgeConfig = {
  mode: "contributor",
  modeSource: "probe",
  ecosystemRoot: "/var/empty",
  docs: { state: "available", docsRoot: "/var/empty/exeris-docs", ecosystemRoot: "/var/empty" },
  lsp: LSP_SPEC,
  kernel: KERNEL_SPEC,
  project: { state: "available", projectRoot: "/var/empty/project", source: "env" },
};

const ZERO_CHECKOUT: BridgeConfig = {
  mode: "app",
  modeSource: "probe",
  ecosystemRoot: null,
  docs: dark("docs"),
  project: { state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" },
  lsp: dark("lsp"),
  kernel: dark("kernel"),
};

/** An LSP channel that connects but never answers, so a close can be driven by hand. */
class SilentLspChannel implements LspChannel {
  private closeHandler: ((r: LspCloseReason) => void) | null = null;
  write(): void {}
  onData(): void {}
  onClose(handler: (r: LspCloseReason) => void): void {
    this.closeHandler = handler;
  }
  close(): void {}
  kill(reason: LspCloseReason): void {
    this.closeHandler?.(reason);
  }
}

/** A kernel channel that connects and never answers. */
class SilentKernelChannel implements KernelChannel {
  write(): void {}
  onData(): void {}
  onClose(): void {}
  close(): void {}
}

function tools(config: BridgeConfig, transports?: { lsp?: LspClient; kernel?: KernelAdapter }) {
  return new Map(registerBridgeTools(config, transports).map((t) => [t.definition.name, t]));
}

function payload(res: CallToolResult): any {
  return JSON.parse((res.content[0] as { text: string }).text);
}

const NO_BUNDLE: BundleState = {
  state: "unavailable",
  reason: "no bundle (test)",
  remedy: "generate one (test)",
};

async function call(
  config: BridgeConfig,
  name: string,
  transports?: { lsp?: LspClient; kernel?: KernelAdapter },
  bundle: BundleState = NO_BUNDLE,
  rootOverride?: string,
) {
  const tool = new Map(
    registerBridgeTools(config, transports, bundle, rootOverride).map((t) => [t.definition.name, t]),
  ).get(name);
  assert.ok(tool, `${name} is not registered`);
  const res = await tool.handler({});
  assert.ok(!res.isError, `${name} returned an error: ${(res.content[0] as { text: string }).text}`);
  return payload(res);
}

// ---------------------------------------------------------------------------
// registration

test("registerBridgeTools registers exactly bridge-version and bridge-health", () => {
  const names = registerBridgeTools(LIVE).map((t) => t.definition.name);
  assert.deepEqual(names.sort((a, b) => a.localeCompare(b)), ["bridge-health", "bridge-version"]);
});

test("bridge-* answers on a config where every other family is dark", async () => {
  // The family that explains the others cannot itself be one of the others.
  // It has no external dependency to resolve, so it is never gated.
  for (const name of ["bridge-version", "bridge-health"]) {
    await call(ZERO_CHECKOUT, name);
  }
});

// ---------------------------------------------------------------------------
// bridge:version

test("bridge-version identifies the build and the resolved mode", async () => {
  const body = await call(LIVE, "bridge-version");
  assert.equal(body.name, "exeris-ai-bridge");
  assert.equal(body.version, getServerVersion());
  assert.equal(body.node, process.version);
  assert.equal(body.mode, "contributor");
  assert.equal(body.modeSource, "probe");
});

test("bridge-version reports a pinned mode as env-sourced", async () => {
  const body = await call({ ...ZERO_CHECKOUT, mode: "contributor", modeSource: "env" }, "bridge-version");
  assert.equal(body.mode, "contributor");
  assert.equal(body.modeSource, "env");
});

// ---------------------------------------------------------------------------
// bridge:health

test("bridge-health reports every dark family with its reason and remedy", async () => {
  const body = await call(ZERO_CHECKOUT, "bridge-health");
  assert.equal(body.mode, "app");
  assert.deepEqual(
    body.families,
    [
      { family: "docs", state: "unavailable", reason: "docs reason", remedy: "docs remedy" },
      { family: "lsp", state: "unavailable", reason: "lsp reason", remedy: "lsp remedy" },
      { family: "kernel", state: "unavailable", reason: "kernel reason", remedy: "kernel remedy" },
      // build:* and caps:* share one project resolution, so they are dark
      // together and carry the same reason — two rows, because the agent's
      // unit is the family it calls, not the config field behind it.
      { family: "build", state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" },
      { family: "caps", state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" },
      { family: "sdk", state: "unavailable", reason: "no bundle (test)", remedy: "generate one (test)" },
    ],
  );
});

test("bridge-health reports the launch source and child state of a live family", async () => {
  let spawns = 0;
  const lsp = new LspClient(LSP_SPEC, {
    channelFactory: () => {
      spawns++;
      return new SilentLspChannel();
    },
  });
  const kernel = new KernelAdapter(KERNEL_SPEC, {
    channelFactory: () => {
      spawns++;
      return new SilentKernelChannel();
    },
  });

  const body = await call(LIVE, "bridge-health", { lsp, kernel });

  // docs:* has no child process at all, so it carries no transport key.
  assert.deepEqual(body.families[0], { family: "docs", state: "available" });
  assert.deepEqual(body.families[1], {
    family: "lsp",
    state: "available",
    source: "source-tree",
    transport: { state: "not-started", lastError: null },
  });
  assert.deepEqual(body.families[2], {
    family: "kernel",
    state: "available",
    source: "env-command",
    transport: { state: "not-started", lastError: null },
  });
  assert.deepEqual(body.families[3], { family: "build", state: "available" });
  assert.deepEqual(body.families[4], { family: "caps", state: "available" });
  assert.deepEqual(body.families[5], {
    family: "sdk",
    state: "unavailable",
    reason: "no bundle (test)",
    remedy: "generate one (test)",
  });
  // The whole surface must stay free: an agent may call it as often as it likes.
  assert.equal(spawns, 0, "bridge:health must never spawn a child process");
});

test("bridge-health distinguishes 'no child process' from 'child not visible'", async () => {
  // docs:* omits the key; a child-process family whose instance was not handed
  // in reports null. Collapsing the two would tell an agent that lsp:* has no
  // process, which is false.
  const body = await call(LIVE, "bridge-health");
  assert.equal("transport" in body.families[0], false);
  assert.equal(body.families[1].transport, null);
  assert.equal(body.families[2].transport, null);
});

test("bridge-health renders a terminal close without leaking the launch command", async () => {
  const channel = new SilentLspChannel();
  const spec: LspConfig = { ...LSP_SPEC, args: ["--secret-arg"], source: "env-command" };
  const lsp = new LspClient(spec, { channelFactory: () => channel });

  const pending = lsp.request("exeris/domains");
  await new Promise((resolve) => setTimeout(resolve, 0));
  channel.kill({ kind: "exited", code: 3, signal: null });
  await assert.rejects(pending, LspTransportError);

  const res = await tools({ ...LIVE, lsp: spec }, { lsp }).get("bridge-health")!.handler({});
  const text = (res.content[0] as { text: string }).text;
  assert.equal(payload(res).families[1].transport.lastError, "exited (code=3, signal=none)");

  // The transports embed the launch command in the errors they throw; this
  // surface reports strictly less. `source` already says which rung produced
  // the spec, so the command itself adds nothing and stays off the wire.
  assert.ok(!text.includes("--secret-arg"), `leaked the launch command: ${text}`);
});

test("bridge-health names the artifact version when the ladder resolved one", async () => {
  // Only the local-repository rung resolves a version. "kernel:* is live" and
  // "kernel:* is live against 0.10.2 while your project builds 0.11.0" are
  // different claims, and only the second one is diagnosable.
  const m2: KernelConfig = {
    state: "available",
    command: "java",
    args: ["-jar", "/repo/exeris-kernel-diagnostics-cli-0.10.2.jar"],
    source: "m2",
    artifactVersion: "0.10.2",
  };
  const body = await call({ ...LIVE, kernel: m2 }, "bridge-health");
  assert.equal(body.families[2].source, "m2");
  assert.equal(body.families[2].artifactVersion, "0.10.2");

  // A rung that resolves no version must not report one at all.
  const plain = await call(LIVE, "bridge-health");
  assert.equal("artifactVersion" in plain.families[2], false);
});

// ---------------------------------------------------------------------------
// bundled reference data

test("bridge-version reports an absent bundle as a first-class state", async () => {
  // Absent is the ordinary state of a bridge run from a source checkout, and
  // the first thing to check when the reference surfaces know nothing. Omitting
  // it would make that question unanswerable from the tool surface.
  const body = await call(LIVE, "bridge-version");
  assert.equal(body.bundle.state, "unavailable");
  assert.equal(body.bundle.reason, "no bundle (test)");
  assert.equal(body.bundle.remedy, "generate one (test)");
});

test("bridge-version reports an empty bundle as present, not missing", async () => {
  // 0.5.0 ships exactly this: the mechanism, with content arriving in 0.6.0.
  const bundle: BundleState = {
    state: "available",
    generatedAt: "2026-08-26T00:00:00.000Z",
    bridgeVersion: "0.5.0",
    entries: [],
  };
  const body = await call(LIVE, "bridge-version", undefined, bundle);
  assert.equal(body.bundle.state, "available");
  assert.equal(body.bundle.entryCount, 0);
  assert.deepEqual(body.bundle.sourceArtifacts, []);
});

test("bridge-version names the upstream releases the bundled data came from", async () => {
  // Which release an answer reflects is the question a version tool exists to
  // answer; a file count alone cannot.
  const entry = (id: string, sourceArtifact: string) => ({
    id,
    path: `${id}.json`,
    sha256: "0".repeat(64),
    bytes: 2,
    sourceArtifact,
  });
  const bundle: BundleState = {
    state: "available",
    generatedAt: "2026-08-26T00:00:00.000Z",
    bridgeVersion: "0.6.0",
    entries: [
      entry("catalog", "eu.exeris:exeris-sdk-annotations:0.10.0"),
      entry("ast", "eu.exeris:exeris-tooling-core:0.7.0"),
      entry("scoping", "eu.exeris:exeris-sdk-annotations:0.10.0"),
    ],
  };
  const body = await call(LIVE, "bridge-version", undefined, bundle);
  assert.equal(body.bundle.entryCount, 3);
  // Deduplicated and ordered — three entries from two artifacts.
  assert.deepEqual(body.bundle.sourceArtifacts, [
    "eu.exeris:exeris-sdk-annotations:0.10.0",
    "eu.exeris:exeris-tooling-core:0.7.0",
  ]);
});

function makeTestSdkBundle(dataDir: string, sdkVersion = "0.12.0-SNAPSHOT"): BundleState {
  const catalogText = JSON.stringify({
    catalogFormat: 1,
    sdkVersion,
    annotationCount: 1,
    packages: [],
    annotations: [],
  });
  const schemaText = JSON.stringify({
    schemaFormat: 1,
    sdkVersion,
    astSchemaVersion: "1.0.0",
    definitions: [],
  });
  writeFileSync(join(dataDir, "annotation-catalog.json"), catalogText, "utf8");
  writeFileSync(join(dataDir, "ast-schema.json"), schemaText, "utf8");

  const catalogHash = createHash("sha256").update(Buffer.from(catalogText, "utf8")).digest("hex");
  const schemaHash = createHash("sha256").update(Buffer.from(schemaText, "utf8")).digest("hex");

  return {
    state: "available",
    generatedAt: "2026-09-29T00:00:00.000Z",
    bridgeVersion: "0.7.0",
    entries: [
      {
        id: "annotation-catalog",
        path: "annotation-catalog.json",
        sha256: catalogHash,
        bytes: Buffer.byteLength(catalogText),
        sourceArtifact: `eu.exeris:exeris-sdk-annotation-catalog:${sdkVersion}`,
      },
      {
        id: "ast-schema",
        path: "ast-schema.json",
        sha256: schemaHash,
        bytes: Buffer.byteLength(schemaText),
        sourceArtifact: `eu.exeris:exeris-sdk-ast-schema:${sdkVersion}`,
      },
    ],
  };
}

test("bridge-health reports sdk versionSkew aligned when project matches catalog", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bridge-health-aligned-"));
  const dataDir = join(tmp, "data");
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(
      join(tmp, "pom.xml"),
      `<project><dependencies><dependency><groupId>eu.exeris</groupId><artifactId>exeris-sdk</artifactId><version>0.12.0-SNAPSHOT</version></dependency></dependencies></project>`,
      "utf8",
    );
    const config: BridgeConfig = {
      ...LIVE,
      project: { state: "available", projectRoot: tmp, source: "env" },
    };
    const bundle = makeTestSdkBundle(dataDir, "0.12.0-SNAPSHOT");
    const body = await call(config, "bridge-health", undefined, bundle, dataDir);
    const sdkFamily = body.families.find((f: any) => f.family === "sdk");
    assert.ok(sdkFamily);
    assert.equal(sdkFamily.state, "available");
    assert.equal(sdkFamily.versionSkew?.status, "aligned");
    assert.equal(sdkFamily.versionSkew?.bundledSdkVersion, "0.12.0-SNAPSHOT");
    assert.equal(sdkFamily.versionSkew?.projectSdkVersion, "0.12.0-SNAPSHOT");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bridge-health reports sdk versionSkew skew_detected when project pins different version", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bridge-health-skew-"));
  const dataDir = join(tmp, "data");
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(
      join(tmp, "pom.xml"),
      `<project><dependencies><dependency><groupId>eu.exeris</groupId><artifactId>exeris-sdk</artifactId><version>0.10.0</version></dependency></dependencies></project>`,
      "utf8",
    );
    const config: BridgeConfig = {
      ...LIVE,
      project: { state: "available", projectRoot: tmp, source: "env" },
    };
    const bundle = makeTestSdkBundle(dataDir, "0.12.0-SNAPSHOT");
    const body = await call(config, "bridge-health", undefined, bundle, dataDir);
    const sdkFamily = body.families.find((f: any) => f.family === "sdk");
    assert.ok(sdkFamily);
    assert.equal(sdkFamily.state, "available");
    assert.equal(sdkFamily.versionSkew?.status, "skew_detected");
    assert.equal(sdkFamily.versionSkew?.bundledSdkVersion, "0.12.0-SNAPSHOT");
    assert.equal(sdkFamily.versionSkew?.projectSdkVersion, "0.10.0");
    assert.ok(sdkFamily.versionSkew?.warning?.includes("0.10.0"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bridge-health reports sdk versionSkew unknown when project has no SDK or missing pom", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bridge-health-unknown-"));
  const dataDir = join(tmp, "data");
  mkdirSync(dataDir, { recursive: true });
  try {
    const config: BridgeConfig = {
      ...LIVE,
      project: { state: "available", projectRoot: tmp, source: "env" },
    };
    const bundle = makeTestSdkBundle(dataDir, "0.12.0-SNAPSHOT");
    const body = await call(config, "bridge-health", undefined, bundle, dataDir);
    const sdkFamily = body.families.find((f: any) => f.family === "sdk");
    assert.ok(sdkFamily);
    assert.equal(sdkFamily.state, "available");
    assert.equal(sdkFamily.versionSkew?.status, "unknown");
    assert.equal(sdkFamily.versionSkew?.bundledSdkVersion, "0.12.0-SNAPSHOT");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bridge-health reports sdk versionSkew unknown when catalog cannot be read", async () => {
  const badBundle: BundleState = {
    state: "available",
    generatedAt: "2026-08-26T00:00:00.000Z",
    bridgeVersion: "0.7.0",
    entries: [
      {
        id: "annotation-catalog",
        path: "non-existent-catalog.json",
        sha256: "0".repeat(64),
        bytes: 0,
        sourceArtifact: "eu.exeris:exeris-sdk-annotation-catalog:0.12.0",
      },
      {
        id: "ast-schema",
        path: "non-existent-schema.json",
        sha256: "0".repeat(64),
        bytes: 0,
        sourceArtifact: "eu.exeris:exeris-sdk-ast-schema:0.12.0",
      },
    ],
  };
  const body = await call(LIVE, "bridge-health", undefined, badBundle);
  const sdkFamily = body.families.find((f: any) => f.family === "sdk");
  assert.ok(sdkFamily);
  assert.equal(sdkFamily.state, "available");
  assert.equal(sdkFamily.versionSkew?.status, "unknown");
  assert.equal(sdkFamily.versionSkew?.bundledSdkVersion, "unknown");
});

test("bridge-health reports sdk family unavailable when bundle has no catalog entry", async () => {
  const emptyBundle: BundleState = {
    state: "available",
    generatedAt: "2026-08-26T00:00:00.000Z",
    bridgeVersion: "0.7.0",
    entries: [],
  };
  const body = await call(LIVE, "bridge-health", undefined, emptyBundle);
  const sdkFamily = body.families.find((f: any) => f.family === "sdk");
  assert.ok(sdkFamily);
  assert.equal(sdkFamily.state, "unavailable");
  assert.equal(sdkFamily.reason, "The bundled reference data carries no annotation catalog.");
});

