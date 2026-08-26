#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The P2 smoke test — the item that closes ROADMAP 0.5.0.
//
// Every other test in this repo runs against the source tree, inside an
// ecosystem checkout, with the developer's own environment. That is precisely
// the machine the zero-checkout contract is NOT about. This one builds the real
// tarball, installs it into a scratch directory that holds only an application
// project, points HOME at an empty directory, scrubs every EXERIS_* variable,
// and then speaks MCP to the installed binary over stdio.
//
// What it proves that the unit tests cannot:
//   - the PACKAGE boots — `files`, `bin`, and the prepack-generated `data/` are
//     all correct, not just the sources they were built from
//   - the server survives a machine with no ecosystem, no ~/.m2, no config
//   - `tools/list` is byte-identical between a fully dark server and one with a
//     family lit, through the real transport rather than the registry API
//   - a dark family answers `family_unavailable` on the wire
//
// Usage:  npm run smoke:p2        (builds first)
//         node scripts/p2-smoke.mjs --keep    (leaves the scratch dir behind)

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const KEEP = process.argv.includes("--keep");

// npm's own CLI, as an absolute path, taken from the npm that invoked this
// script. Two reasons, and neither is style: `pack` and `install` must run on
// the SAME npm that manages the project (a machine with several on PATH would
// otherwise pack with one and install with another), and resolving the binary
// through PATH would let a writable PATH entry decide what this test executes.
//
// Set by npm for anything it runs, so `npm run smoke:p2` works and a bare
// `node scripts/p2-smoke.mjs` is refused with the invocation that does.
const NPM_CLI = process.env.npm_execpath;
if (NPM_CLI === undefined || NPM_CLI.length === 0) {
  throw new Error(
    "run this through npm so it can find npm: `npm run smoke:p2` (pass flags after `--`, e.g. `npm run smoke:p2 -- --keep`)",
  );
}

/** Run an npm subcommand on the resolved CLI, never on a PATH lookup. */
function npm(args, options) {
  execFileSync(process.execPath, [NPM_CLI, ...args], options);
}

// Cold `npm install` plus a Node boot; generous, but a hang must still fail the
// job rather than sit until the CI runner's own timeout.
const REQUEST_TIMEOUT_MS = 30_000;

const scratch = mkdtempSync(join(tmpdir(), "exeris-p2-smoke-"));

async function main() {
  const tarball = pack();
  const project = writeApplicationProject();
  install(project, tarball);

  // An empty HOME is what takes the local-Maven-repository rung of the launch
  // ladder off the table. Without it the test would read the developer's real
  // ~/.m2 and pass or fail by machine — the same hermeticity trap the unit
  // tests close with EXERIS_MAVEN_REPO.
  const home = join(scratch, "home");
  mkdirSync(home);

  assertZeroCheckout(project, home);

  const dark = await interrogate(project, home, {});
  assertBootsDark(dark);

  // Same install, same clean machine, one family lit by rung 1. The only thing
  // that may differ between the two runs is the ANSWERS.
  const lit = await interrogate(project, home, { EXERIS_KERNEL_COMMAND: "/bin/cat" });
  assertSurfaceInvariant(dark, lit);
  assertLadderResolves(lit);
}

// ---------------------------------------------------------------------------
// Building the P2 machine

/** Build the real tarball, prepack and all. */
function pack() {
  const out = join(scratch, "tarball");
  mkdirSync(out);
  // Packed into an empty directory and read back, rather than parsed out of
  // npm's stdout: the prepack lifecycle script writes there too.
  npm(["pack", "--pack-destination", out], { cwd: PACKAGE_ROOT, stdio: "inherit" });
  const files = readdirSync(out);
  assert.equal(files.length, 1, `expected exactly one tarball in ${out}, got ${files.join(", ")}`);
  return join(out, files[0]);
}

/**
 * The application project: a Maven build with one annotated source.
 *
 * No tool reads any of this at 0.5.0 — `build:*` is 0.7.0. It is here because
 * the claim under test is about a machine, not a directory: the assertions
 * below state that a real project on disk lights no family and does not flip
 * the mode, which is only worth stating if a real project is present.
 *
 * The package.json is not scenery. `npm install` in a directory without one
 * walks UP the tree looking for a project — from a tmpdir that is usually
 * harmless, but the failure mode if it ever is not is installing the tarball
 * into someone else's node_modules.
 */
function writeApplicationProject() {
  const project = join(scratch, "project");
  const sources = join(project, "src", "main", "java", "com", "example", "billing");
  mkdirSync(sources, { recursive: true });

  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "p2-smoke-app", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    join(project, "pom.xml"),
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<project xmlns="http://maven.apache.org/POM/4.0.0">`,
      `  <modelVersion>4.0.0</modelVersion>`,
      `  <groupId>com.example</groupId>`,
      `  <artifactId>billing</artifactId>`,
      `  <version>1.0.0-SNAPSHOT</version>`,
      `  <dependencies>`,
      `    <dependency>`,
      `      <groupId>eu.exeris</groupId>`,
      `      <artifactId>exeris-sdk</artifactId>`,
      `      <version>0.10.0</version>`,
      `    </dependency>`,
      `  </dependencies>`,
      `</project>`,
      ``,
    ].join("\n"),
  );
  writeFileSync(
    join(sources, "Invoice.java"),
    [
      `package com.example.billing;`,
      ``,
      `import eu.exeris.sdk.annotations.ExerisDomain;`,
      ``,
      `@ExerisDomain`,
      `public class Invoice {}`,
      ``,
    ].join("\n"),
  );
  return project;
}

/**
 * `--ignore-scripts` because this install must not execute anything: the point
 * is to observe what the tarball does when the SERVER runs, and a lifecycle
 * script firing first would be both a confound and an execution path nothing
 * here reviewed. Our own package declares no install script, so it changes
 * nothing about what is being tested.
 */
function install(project, tarball) {
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", tarball], {
    cwd: project,
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// Assertions

/**
 * The trap this whole test can fall into.
 *
 * `defaultDocsRoot()` walks three levels up from `dist/config`, which in an
 * npm install lands on `node_modules/@exeris/exeris-docs` — absent, so docs:*
 * goes dark and everything below passes. If a future change to that default
 * ever made it resolve, the test would keep passing while testing nothing.
 * Both halves of "there is no ecosystem here" are therefore asserted directly.
 */
function assertZeroCheckout(project, home) {
  const sibling = join(project, "node_modules", "@exeris", "exeris-docs");
  assert.equal(
    existsSync(sibling),
    false,
    `the install-neighbour docs default resolved (${sibling}) — this run is no longer zero-checkout, ` +
      `so every assertion below has stopped testing what it claims to test`,
  );
  assert.equal(existsSync(join(home, ".m2")), false, "the scratch HOME must not carry a Maven repository");
  assert.equal(
    existsSync(join(project, "node_modules", "@exeris", "ai-bridge", "data", "manifest.json")),
    true,
    "the installed package is missing data/manifest.json — prepack did not run, or `files` dropped data/",
  );
}

function assertBootsDark({ initialize, tools, version, health, calls, stderr }) {
  assert.equal(initialize.serverInfo.name, "exeris-ai-bridge");
  assert.equal(
    initialize.serverInfo.version,
    PKG.version,
    "the running server reports a different version than package.json — a stale build was installed",
  );

  assert.equal(version.mode, "app", "a machine with no checkout must resolve to application-developer mode");
  assert.equal(version.modeSource, "probe", "nothing pinned the mode, so it must have been inferred");
  assert.equal(version.version, PKG.version);

  // The bundle ships inside the tarball, so unlike every other surface it is
  // live on a bare machine. Zero entries is the honest 0.5.0 state; 0.6.0 fills
  // it, and this assertion is what will notice when it does.
  assert.equal(version.bundle.state, "available", "the bundled reference data did not survive packaging");
  assert.equal(version.bundle.entryCount, 0);
  assert.equal(version.bundle.bridgeVersion, PKG.version);

  assert.equal(health.mode, "app");
  const dark = new Map(health.families.map((f) => [f.family, f]));
  assert.deepEqual([...dark.keys()].sort((a, b) => a.localeCompare(b)), ["docs", "kernel", "lsp"]);
  for (const [family, report] of dark) {
    assert.equal(report.state, "unavailable", `${family}:* resolved on a machine that has nothing to resolve it from`);
    assert.ok(report.reason?.length > 0, `${family}:* is dark without a reason`);
    assert.ok(report.remedy?.length > 0, `${family}:* is dark without a remedy`);
    // reason/remedy are agent-facing and bridge:health relays them verbatim;
    // machine paths belong on stderr. Checking against the paths this run
    // actually used catches a leak without guessing at what one looks like.
    for (const secret of [scratch, tmpdir()]) {
      assert.equal(report.reason.includes(secret), false, `${family}:* reason leaks a machine path`);
      assert.equal(report.remedy.includes(secret), false, `${family}:* remedy leaks a machine path`);
    }
  }

  // A dark family answers on the wire, rather than failing at spawn time with a
  // transport error that cannot say what to do about it.
  for (const [name, result] of calls) {
    const family = name.split(":")[0];
    assert.equal(result.isError, true, `${name} did not report an error`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error, "family_unavailable", `${name} failed some other way: ${result.content[0].text}`);
    assert.equal(payload.family, family);
    assert.ok(payload.remedy?.length > 0);
  }

  assert.match(
    stderr,
    /^\[exeris-ai-bridge\] mode=app \(probe\) docs=unavailable lsp=unavailable kernel=unavailable$/m,
    `the boot summary is missing or wrong; stderr was:\n${stderr}`,
  );
}

/**
 * 1.0 freezes `tools/list` under semver and MCP clients cache it at connect
 * time, so the surface cannot vary with the environment. `server.test.ts` holds
 * this at the registry; here it is held across two real processes, which is
 * where a client would actually observe it breaking.
 */
function assertSurfaceInvariant(dark, lit) {
  assert.deepEqual(
    lit.tools,
    dark.tools,
    "tools/list changed when a family was lit — the 1.0 surface freeze is not implementable",
  );
  assert.ok(dark.tools.length >= 2, "expected a non-trivial tool surface");
  const names = dark.tools.map((t) => t.name);
  assert.deepEqual(
    names.filter((n) => n.startsWith("bridge:")).sort((a, b) => a.localeCompare(b)),
    ["bridge:health", "bridge:version"],
    "bridge:* is frozen at two tools by the ADR-025 2026-08-26 addendum",
  );
  for (const family of ["docs", "lsp", "kernel"]) {
    assert.ok(names.some((n) => n.startsWith(`${family}:`)), `${family}:* vanished from tools/list`);
  }
}

/** The launch ladder resolves through a real install, not only in a unit test. */
function assertLadderResolves({ health }) {
  const kernel = health.families.find((f) => f.family === "kernel");
  assert.equal(kernel.state, "available", "EXERIS_KERNEL_COMMAND did not light kernel:*");
  assert.equal(kernel.source, "env-command");
  // Constructed, never spawned: bridge:health is a zero-spawn surface, so the
  // child must still be idle after it has been reported on.
  assert.equal(kernel.transport.state, "not-started");
}

// ---------------------------------------------------------------------------
// Driving the installed server

/**
 * Boot the installed binary on a scrubbed environment and ask it everything the
 * assertions need, in one session.
 *
 * The environment is built from nothing rather than filtered from the parent:
 * a deny-list would have to be updated every time a new EXERIS_* variable is
 * added, and would fail open when someone forgot.
 */
async function interrogate(project, home, extraEnv) {
  const bin = join(project, "node_modules", ".bin", "exeris-ai-bridge");
  assert.equal(existsSync(bin), true, `the package did not install its bin: ${bin}`);

  const child = spawn(bin, [], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const client = new StdioClient(child);
  try {
    const initialize = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "p2-smoke", version: "0" },
    });
    client.notify("notifications/initialized", {});

    const { tools } = await client.request("tools/list", {});
    const version = await client.callJson("bridge:version");
    const health = await client.callJson("bridge:health");

    // One gated tool per family, to see the dark path on the wire. All of them
    // is server.test.ts's job; this is about the transport, not the coverage.
    const calls = [];
    for (const name of ["docs:list_adrs", "lsp:list_domains", "kernel:list_providers"]) {
      calls.push([name, await client.request("tools/call", { name, arguments: {} })]);
    }

    assert.equal(child.exitCode, null, "the server exited during the session");
    return { initialize, tools, version, health, calls, stderr: client.stderr };
  } finally {
    client.dispose();
  }
}

/**
 * A minimal MCP stdio client: newline-delimited JSON-RPC, no SDK.
 *
 * Hand-rolled on purpose. The SDK client would paper over exactly the failure
 * this test exists to catch — anything the server writes to stdout that is not
 * a message desyncs an agent, and here it throws instead.
 */
class StdioClient {
  #child;
  #pending = new Map();
  #buffer = "";
  #nextId = 1;
  #fatal = null;
  stderr = "";

  constructor(child) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    child.on("error", (err) => this.#fail(new Error(`server failed to start: ${err.message}`)));
    child.on("exit", (code, signal) =>
      this.#fail(new Error(`server exited (code=${code}, signal=${signal})\nstderr:\n${this.stderr}`)),
    );
  }

  #onStdout(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new Error(`server wrote non-JSON to stdout, which desyncs the MCP stream: ${line}`));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue; // a notification or a stale id
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      else pending.resolve(message.result);
    }
  }

  #fail(err) {
    this.#fatal ??= err;
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #send(payload) {
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  request(method, params) {
    // `instanceof` rather than a null check: #fatal only ever holds an Error,
    // and saying so here is what makes the rejection reason provable at the
    // call site rather than merely true.
    if (this.#fatal instanceof Error) return Promise.reject(this.#fatal);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms\nstderr:\n${this.stderr}`));
        },
        REQUEST_TIMEOUT_MS,
      );
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Call a tool that answers with a single JSON text block, and decode it. */
  async callJson(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    assert.equal(result.isError, undefined, `${name} reported an error: ${result.content?.[0]?.text}`);
    return JSON.parse(result.content[0].text);
  }

  dispose() {
    this.#child.removeAllListeners("exit");
    this.#child.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------------------
// Entry point
//
// Last in the file, not first: `main` is hoisted but `StdioClient` is not, and
// a top-level await above the class declaration reaches it before it exists.

try {
  await main();
  console.log(`\n[p2-smoke] PASS — ${PKG.name}@${PKG.version} boots and answers with no ecosystem on disk`);
} finally {
  if (KEEP) console.log(`[p2-smoke] scratch kept at ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
