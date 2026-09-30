import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// server.json is what the MCP Registry lists, and the registry verifies it
// against package.json's `mcpName` at publish time. A mismatch surfaces only
// then, in the release job, after the npm package is already out — so the
// two are held equal here, on every change.

// After build this file lives at dist/, so the package root is one level up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ServerJson {
  name: string;
  version: string;
  description: string;
  packages: { registryType: string; identifier: string; version: string; transport: { type: string } }[];
}

function read<T>(file: string): T {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;
}

const pkg = read<{ name: string; version: string; mcpName: string }>("package.json");
const server = read<ServerJson>("server.json");

test("server.json names the server package.json's mcpName declares", () => {
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.exeris-systems\//, "GitHub OIDC login grants the organisation namespace");
});

test("server.json describes exactly this npm package at this version", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  const [npm] = server.packages;
  assert.equal(npm.registryType, "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(npm.transport.type, "stdio");
});

test("server.json's description fits the registry's 100-character limit", () => {
  assert.ok(server.description.length <= 100, `${server.description.length} characters`);
});
