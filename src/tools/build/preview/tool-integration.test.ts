import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../../../config/env.js";
import { findArtifactJar, resolveLocalRepository } from "../../../config/maven.js";
import { writeCatalogueBundle } from "../../../data/__tests__/generator-catalogue-fixture.js";
import { registerBuildTools } from "../index.js";
import { MIN_JAVA_MAJOR, probeJavaMajor } from "./resolve-generator.js";

// Live test: runs the released exeris-codegen-cli over a small metadata fixture
// through the same path production uses (pom.xml pin -> local Maven repository
// -> `java -jar`). Skipped when the jar is not in the local repository or no
// Java of the required major is on PATH; the bridge's own CI carries neither.

const VERSION = "0.10.0";

function skipReason(): string | false {
  const repo = resolveLocalRepository(process.env);
  if (repo === null || findArtifactJar(repo, { groupId: "eu.exeris", artifactId: "exeris-codegen-cli" }, VERSION) === null) {
    return `eu.exeris:exeris-codegen-cli:${VERSION} is not in the local Maven repository`;
  }
  const major = probeJavaMajor(process.env);
  return major === null || major < MIN_JAVA_MAJOR ? `a Java ${MIN_JAVA_MAJOR}+ runtime is not on PATH` : false;
}

const POM = `<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>eu.exeris</groupId>
    <artifactId>exeris-app-parent</artifactId>
    <version>${VERSION}</version>
  </parent>
  <artifactId>fixture</artifactId>
</project>
`;

const TICKET = JSON.stringify({
  entityName: "Ticket",
  packageName: "com.example.tickets.domain",
  module: "tickets",
  path: "/tickets",
  fields: [
    { name: "id", type: "java.util.UUID", inCreate: true, inUpdate: true },
    { name: "title", type: "java.lang.String", inCreate: true, inUpdate: true },
  ],
  events: [],
  actions: [],
  relationships: [],
  validations: [],
  indexes: [],
});

function hashTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isDirectory()) {
        hash.update(`D ${prefix}/${name}\n`);
        walk(full, `${prefix}/${name}`);
      } else {
        hash.update(`F ${prefix}/${name} ${createHash("sha256").update(readFileSync(full)).digest("hex")}\n`);
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

test(
  "build-preview_generation runs the real Java generator, leaves the project untouched, and an unchanged tree reports no changes",
  { skip: skipReason(), timeout: 180_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "exeris-preview-live-"));
    try {
      const project = join(scratch, "project");
      const tmpRoot = join(scratch, "tmp");
      mkdirSync(join(project, "target", "classes", "exeris-metadata"), { recursive: true });
      mkdirSync(tmpRoot);
      writeFileSync(join(project, "pom.xml"), POM);
      writeFileSync(join(project, "target", "classes", "exeris-metadata", "Ticket.json"), TICKET);

      const na = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };
      const config: BridgeConfig = {
        mode: "app",
        modeSource: "default",
        ecosystemRoot: null,
        docs: na,
        lsp: na,
        kernel: na,
        project: { state: "available", projectRoot: project, source: "env" },
      };
      const bundleDir = mkdtempSync(join(scratch, "bundle-"));
      const tool = registerBuildTools(config, writeCatalogueBundle(bundleDir), bundleDir, { tmpRoot }).find(
        (t) => t.definition.name === "build-preview_generation",
      )!;

      const before = hashTree(project);
      const first = await tool.handler({ target: "java" });
      assert.equal(first.isError, undefined, text(first));
      const firstOut = JSON.parse(text(first));
      assert.equal(firstOut.exitCode, 0);
      assert.equal(firstOut.generator.kind, "java");
      assert.equal(firstOut.generator.version, VERSION);
      assert.equal(firstOut.generator.source, "m2");
      assert.ok(firstOut.files.added.length > 0, "the generator produced files");
      assert.ok(
        firstOut.files.added.some((f: { path: string }) => f.path.endsWith("TicketRepository.java")),
        "the Ticket entity's repository was generated",
      );
      assert.deepEqual(firstOut.files.changed, []);
      assert.equal(hashTree(project), before);
      assert.deepEqual(readdirSync(tmpRoot), []);

      // Commit what the preview showed as L1 (the test plays the build), then preview again: the
      // generator, seeded with that tree and its manifest, has nothing to change.
      const l1 = join(project, "src", "main", "generated", "java");
      for (const f of firstOut.files.added as { path: string; diff: string }[]) {
        const lines = f.diff.split("\n");
        const added = lines
          .slice(lines.findIndex((l) => l.startsWith("@@")) + 1)
          .filter((l) => l.startsWith("+"))
          .map((l) => l.slice(1));
        const noFinalNewline = f.diff.includes("\\ No newline at end of file");
        const body = added.length === 0 ? "" : added.join("\n") + (noFinalNewline ? "" : "\n");
        mkdirSync(dirname(join(l1, f.path)), { recursive: true });
        writeFileSync(join(l1, f.path), body);
      }
      // The manifest is bookkeeping the tool does not list; a committed tree carries it, so write it.
      const paths = (firstOut.files.added as { path: string }[]).map((f) => f.path).sort();
      writeFileSync(
        join(l1, ".exeris-codegen-manifest"),
        `# Exeris Tooling generated-output manifest - DO NOT EDIT MANUALLY\n${paths.join("\n")}\n`,
      );
      const committed = hashTree(project);
      const second = await tool.handler({ target: "java" });
      assert.equal(second.isError, undefined, text(second));
      const secondOut = JSON.parse(text(second));
      assert.equal(secondOut.exitCode, 0);
      assert.deepEqual(secondOut.files.added, []);
      assert.deepEqual(secondOut.files.removed, []);
      assert.ok(secondOut.files.unchanged.length > 0);
      assert.deepEqual(secondOut.files.changed, []);
      assert.equal(secondOut.l1.seeded, true);
      assert.equal(hashTree(project), committed);
      assert.deepEqual(readdirSync(tmpRoot), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
