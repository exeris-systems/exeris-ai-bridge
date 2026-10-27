import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  MIN_JAVA_MAJOR,
  parseJavaMajor,
  probeJavaMajor,
  resolveJavaGenerator,
  resolveTypeScriptGenerator,
  type GeneratorResolution,
  type ResolvedGenerator,
} from "./resolve-generator.js";

let work: string;
let project: string;
let repo: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-resolve-"));
  project = join(work, "project");
  repo = join(work, "m2");
  mkdirSync(project);
  mkdirSync(repo);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const parentPom = (version: string): string => `<project>
  <parent>
    <groupId>eu.exeris</groupId>
    <artifactId>exeris-app-parent</artifactId>
    <version>${version}</version>
  </parent>
  <artifactId>app</artifactId>
</project>`;

const pluginPom = (version: string): string => `<project>
  <properties><codegen.version>0.9.1</codegen.version></properties>
  <build><plugins>
    <plugin>
      <groupId>eu.exeris</groupId>
      <artifactId>exeris-codegen-maven-plugin</artifactId>
      <version>${version}</version>
    </plugin>
  </plugins></build>
</project>`;

function installCli(version: string): string {
  const dir = join(repo, "eu", "exeris", "exeris-codegen-cli", version);
  mkdirSync(dir, { recursive: true });
  const jar = join(dir, `exeris-codegen-cli-${version}.jar`);
  writeFileSync(jar, "fake jar");
  return jar;
}

const env = (): NodeJS.ProcessEnv => ({ EXERIS_MAVEN_REPO: repo });

function java(major: number | null) {
  return { env: env(), javaMajor: () => major };
}

function available(r: GeneratorResolution): ResolvedGenerator {
  assert.equal(r.state, "available", JSON.stringify(r));
  return r;
}

function unavailable(r: GeneratorResolution): { reason: string; remedy: string } {
  assert.equal(r.state, "unavailable");
  assert.ok(r.state === "unavailable");
  return r;
}

test("java: the app-parent version pins the jar, and the launch follows ADR-097", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  const jar = installCli("0.10.0");
  const gen = available(resolveJavaGenerator(project, java(26)));
  assert.equal(gen.kind, "java");
  assert.equal(gen.version, "0.10.0");
  const launch = gen.launch("/meta", "/work");
  assert.equal(launch.command, "java");
  // The crash log and the JVM's working directory are the scratch directory, never the project.
  assert.deepEqual(launch.args, [
    `-XX:ErrorFile=${join("/work", "hs_err_pid%p.log")}`,
    "-jar",
    jar,
    "--metadata-dir=/meta",
    `--output-dir=${join("/work", "out")}`,
  ]);
  assert.equal(launch.cwd, "/work");
  assert.equal(launch.outputDir, join("/work", "out"));
  assert.equal(launch.env.TMPDIR, "/work");
});

test("java: the app-parent version wins over a plugin version", () => {
  writeFileSync(
    join(project, "pom.xml"),
    parentPom("0.10.0").replace("</project>", pluginPom("0.9.1").replace(/<\/?project>/g, "") + "</project>"),
  );
  installCli("0.10.0");
  installCli("0.9.1");
  assert.equal(available(resolveJavaGenerator(project, java(25))).version, "0.10.0");
});

test("java: without an app parent the codegen plugin version pins the jar", () => {
  writeFileSync(join(project, "pom.xml"), pluginPom("0.9.1"));
  installCli("0.9.1");
  assert.equal(available(resolveJavaGenerator(project, java(25))).version, "0.9.1");
});

test("java: a plugin version given as a property is resolved", () => {
  writeFileSync(join(project, "pom.xml"), pluginPom("${codegen.version}"));
  installCli("0.9.1");
  assert.equal(available(resolveJavaGenerator(project, java(25))).version, "0.9.1");
});

test("java: the pinned jar missing is unavailable, never another version", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  installCli("0.9.0");
  installCli("0.11.0");
  const r = unavailable(resolveJavaGenerator(project, java(26)));
  assert.match(r.reason, /exeris-codegen-cli:0\.10\.0 is not in the local Maven repository/);
  assert.match(r.reason, /does not download/);
  assert.match(r.remedy, /0\.10\.0/);
});

test("java: the launch environment carries no *_OPTIONS variable", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  installCli("0.10.0");
  const gen = available(
    resolveJavaGenerator(project, {
      env: { ...env(), JAVA_TOOL_OPTIONS: "-Xmx1m", JDK_JAVA_OPTIONS: "-Xmx1m", NODE_OPTIONS: "--x", PATH: "/usr/bin" },
      javaMajor: () => 26,
    }),
  );
  const launched = gen.launch("/meta", "/work").env;
  assert.deepEqual(Object.keys(launched).sort(), ["PATH", "TEMP", "TMP", "TMPDIR"]);
});

test("java: a version that is a path is unavailable and nothing outside the repository is launched", () => {
  const evil = join(work, "evil");
  mkdirSync(evil);
  writeFileSync(join(evil, "exeris-codegen-cli-9.jar"), "not ours");
  for (const version of ["../../../../evil", "..", "0.10.0/../../x", "0..1", "-1.0"]) {
    writeFileSync(join(project, "pom.xml"), parentPom(version));
    const r = unavailable(resolveJavaGenerator(project, java(26)));
    assert.match(r.reason, /not a plain Maven version/, version);
  }
});

test("java: a jar that is a link out of the local repository is not launched", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  const elsewhere = join(work, "elsewhere.jar");
  writeFileSync(elsewhere, "not ours");
  const dir = join(repo, "eu", "exeris", "exeris-codegen-cli", "0.10.0");
  mkdirSync(dir, { recursive: true });
  symlinkSync(elsewhere, join(dir, "exeris-codegen-cli-0.10.0.jar"));
  assert.match(unavailable(resolveJavaGenerator(project, java(26))).reason, /outside the local Maven repository/);
});

test("java: no local Maven repository is unavailable", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  const r = unavailable(
    resolveJavaGenerator(project, { env: { EXERIS_MAVEN_REPO: join(work, "absent") }, javaMajor: () => 26 }),
  );
  assert.match(r.reason, /No local Maven repository/);
});

test("java: a pom that pins no tooling version is unavailable", () => {
  writeFileSync(join(project, "pom.xml"), "<project><artifactId>x</artifactId></project>");
  installCli("0.10.0");
  assert.match(unavailable(resolveJavaGenerator(project, java(26))).reason, /no tooling version is pinned/);
});

test("java: an unresolvable parent property is unavailable", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("${missing}"));
  assert.match(unavailable(resolveJavaGenerator(project, java(26))).reason, /not a concrete version/);
});

test("java: no pom.xml is unavailable", () => {
  assert.match(unavailable(resolveJavaGenerator(project, java(26))).reason, /no readable pom\.xml/);
});

test("java: an old JDK is unavailable and names the minimum", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  installCli("0.10.0");
  const r = unavailable(resolveJavaGenerator(project, java(MIN_JAVA_MAJOR - 1)));
  assert.match(r.reason, /Java 25 or newer; the 'java' found is version 24/);
});

test("java: no runnable java is unavailable", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  installCli("0.10.0");
  assert.match(unavailable(resolveJavaGenerator(project, java(null))).reason, /No 'java' executable/);
});

test("parseJavaMajor reads modern and legacy version strings", () => {
  assert.equal(parseJavaMajor('java version "26" 2026-03-17'), 26);
  assert.equal(parseJavaMajor('openjdk version "25.0.1" 2025-10-21'), 25);
  assert.equal(parseJavaMajor('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajor("nothing"), null);
});

test(
  "probeJavaMajor reads the version a successful 'java -version' prints on stderr",
  { skip: process.platform === "win32" },
  () => {
    const home = join(work, "jdk");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "java"), '#!/bin/sh\necho \'openjdk version "27.0.1" 2026-09-15\' >&2\nexit 0\n');
    chmodSync(join(home, "bin", "java"), 0o755);
    assert.equal(probeJavaMajor({ JAVA_HOME: home }), 27);
    assert.equal(probeJavaMajor({ JAVA_HOME: join(work, "absent") }), null);
  },
);

function installCodegenTs(manifest: object, binFile: string | null): string {
  const dir = join(project, "node_modules", "@exeris", "codegen-ts");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  if (binFile !== null) writeFileSync(join(dir, binFile), "// bin");
  return dir;
}

test("typescript: the installed package's exeris-gen bin is launched with node", () => {
  const dir = installCodegenTs({ name: "@exeris/codegen-ts", version: "0.10.0", bin: { "exeris-gen": "./dist/index.js" } }, "dist/index.js");
  const gen = available(resolveTypeScriptGenerator(project));
  assert.equal(gen.kind, "typescript");
  assert.equal(gen.version, "0.10.0");
  const launch = gen.launch("/meta", "/work");
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.outputDir, join("/work", "out"));
  assert.equal(launch.cwd, project, "exeris-gen reads exeris-codegen.json from its working directory");
  assert.equal(launch.env.TMPDIR, "/work");
  assert.equal(launch.args[0].endsWith(join("dist", "index.js")), true);
  assert.ok(launch.args[0].startsWith(dir) || launch.args[0].includes("codegen-ts"));
  assert.deepEqual(launch.args.slice(1), ["generate", "--input", "/meta", "--output", join("/work", "out")]);
});

test("typescript: a string bin is accepted", () => {
  installCodegenTs({ version: "0.10.0", bin: "./dist/index.js" }, "dist/index.js");
  assert.equal(available(resolveTypeScriptGenerator(project)).version, "0.10.0");
});

test("typescript: no node_modules is unavailable with a remedy", () => {
  const r = unavailable(resolveTypeScriptGenerator(project));
  assert.match(r.reason, /project's own node_modules/);
  assert.match(r.remedy, /does not download/);
});

test("typescript: a manifest without the exeris-gen bin is unavailable", () => {
  installCodegenTs({ version: "0.10.0", bin: { other: "./dist/index.js" } }, "dist/index.js");
  assert.match(unavailable(resolveTypeScriptGenerator(project)).reason, /no exeris-gen entry/);
});

test("typescript: a bin that does not exist, or leaves the package, is unavailable", () => {
  installCodegenTs({ version: "0.10.0", bin: { "exeris-gen": "./dist/index.js" } }, null);
  assert.match(unavailable(resolveTypeScriptGenerator(project)).reason, /missing or outside the package/);
  installCodegenTs({ version: "0.10.0", bin: { "exeris-gen": "../../../../outside.js" } }, null);
  writeFileSync(join(project, "outside.js"), "//");
  assert.match(unavailable(resolveTypeScriptGenerator(project)).reason, /missing or outside the package/);
});

test("resolver messages carry no absolute paths", () => {
  writeFileSync(join(project, "pom.xml"), parentPom("0.10.0"));
  const r = unavailable(resolveJavaGenerator(project, java(26)));
  assert.ok(!r.reason.includes(work) && !r.remedy.includes(work));
  const t = unavailable(resolveTypeScriptGenerator(project));
  assert.ok(!t.reason.includes(work) && !t.remedy.includes(work));
});
