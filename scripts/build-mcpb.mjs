#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the MCP Bundle (.mcpb) that Claude Desktop installs in one step, from
// the npm tarball the release publishes — so the bundle and the package are the
// same bytes, including the vendored data/ that prepack generated.
//
// Usage: npm run build:mcpb -- <package.tgz> <output-dir>
//
// The bundle's manifest is written here from package.json rather than kept as a
// second file with its own version to drift.
//
// The one user setting is the project root, because a desktop client does not
// start the server inside a project and build-* / caps-* have nothing to read
// without it. EXERIS_DOCS_ROOT is deliberately not offered: the bundle carries
// the registry snapshot, and a contributor with a checkout configures their own
// client. The MCPB specification does not say what an unset optional value
// substitutes to, and an env var set to something unresolvable takes a family
// dark instead of letting its default apply — so only a setting the bundle
// cannot work without is exposed.

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const [tarballArg, outArg] = process.argv.slice(2);
if (tarballArg === undefined || outArg === undefined) {
  console.error("usage: npm run build:mcpb -- <package.tgz> <output-dir>");
  process.exit(2);
}
const tarball = resolve(tarballArg);
const outDir = resolve(outArg);

// Every tool this script runs is npm itself, by absolute path, taken from the
// npm that invoked it — the same rule p2-smoke follows, and for the same
// reason: a PATH lookup would let a writable PATH entry decide what runs, and
// the bundle is a release artifact.
const NPM_CLI = process.env.npm_execpath;
if (NPM_CLI === undefined || NPM_CLI.length === 0) {
  console.error("run this through npm so it can find npm: `npm run build:mcpb -- <package.tgz> <output-dir>`");
  process.exit(2);
}
function npm(args, cwd) {
  execFileSync(process.execPath, [NPM_CLI, ...args], { cwd, stdio: "inherit" });
}

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const stage = mkdtempSync(join(tmpdir(), "exeris-mcpb-"));
try {
  // Installing the tarball unpacks it and resolves its runtime dependencies in
  // one step. `nested` keeps those dependencies inside the package directory,
  // which then is the bundle; no lifecycle script runs, since the tarball is
  // already built and nothing should execute while the bundle is assembled.
  writeFileSync(join(stage, "package.json"), `${JSON.stringify({ private: true })}\n`);
  npm(
    ["install", tarball, "--install-strategy=nested", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    stage,
  );
  const bundle = join(stage, "node_modules", ...pkg.name.split("/"));

  const manifest = {
    manifest_version: "0.3",
    name: "exeris-ai-bridge",
    display_name: "Exeris AI Bridge",
    version: pkg.version,
    description: pkg.description,
    author: { name: "Exeris", url: "https://github.com/exeris-systems" },
    repository: { type: "git", url: "https://github.com/exeris-systems/exeris-ai-bridge" },
    homepage: "https://github.com/exeris-systems/exeris-ai-bridge",
    license: pkg.license,
    server: {
      type: "node",
      entry_point: "dist/server.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/server.js"],
        env: {
          EXERIS_PROJECT_ROOT: "${user_config.project_root}",
        },
      },
    },
    user_config: {
      project_root: {
        type: "directory",
        title: "Project root",
        description:
          "Your own Exeris project, for the build-* and caps-* tools. Claude Desktop does not start the server inside a project, so set this to use them.",
        required: false,
      },
    },
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
  };
  writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, `exeris-ai-bridge-${pkg.version}.mcpb`);
  npm(["exec", "--yes", `--package=${MCPB_CLI}`, "--", "mcpb", "validate", join(bundle, "manifest.json")], stage);
  npm(["exec", "--yes", `--package=${MCPB_CLI}`, "--", "mcpb", "pack", bundle, output], stage);
  console.log(`[build-mcpb] wrote ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
