import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveJavaToolingPin, resolveProjectToolingVersion, resolveTypeScriptToolingPin } from "./tooling-pin.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exeris-tooling-pin-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const parentPom = (version: string, extra = "") =>
  `<project><parent><groupId>eu.exeris</groupId><artifactId>exeris-app-parent</artifactId><version>${version}</version></parent>${extra}</project>`;

const pluginPom = (version: string) =>
  `<project><build><plugins><plugin><groupId>eu.exeris</groupId><artifactId>exeris-codegen-maven-plugin</artifactId><version>${version}</version></plugin></plugins></build></project>`;

function installCodegenTs(version: string): void {
  const dir = join(root, "node_modules", "@exeris", "codegen-ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@exeris/codegen-ts", version }));
}

test("the app-parent version is the pin", () => {
  writeFileSync(join(root, "pom.xml"), parentPom("0.10.0"));
  assert.deepEqual(resolveJavaToolingPin(root), { kind: "pinned", version: "0.10.0", source: "app-parent" });
});

const wrapPlugin = (inner: string) => `<project><build><plugins><plugin>${inner}</plugin></plugins></build></project>`;

test("a plugin whose dependencies and configuration precede its artifactId is still recognised", () => {
  writeFileSync(
    join(root, "pom.xml"),
    wrapPlugin(
      "<dependencies><dependency><groupId>x</groupId><artifactId>other</artifactId><version>9.9.9</version></dependency></dependencies>" +
        "<configuration><version>8.8.8</version></configuration>" +
        "<groupId>eu.exeris</groupId><artifactId>exeris-codegen-maven-plugin</artifactId><version>0.9.2</version>",
    ),
  );
  assert.deepEqual(resolveJavaToolingPin(root), { kind: "pinned", version: "0.9.2", source: "codegen-plugin" });
});

test("a dependency named like the codegen plugin inside another plugin is not the plugin", () => {
  writeFileSync(
    join(root, "pom.xml"),
    wrapPlugin(
      "<groupId>org.example</groupId><artifactId>some-plugin</artifactId><version>1.0.0</version>" +
        "<dependencies><dependency><groupId>eu.exeris</groupId><artifactId>exeris-codegen-maven-plugin</artifactId><version>0.9.3</version></dependency></dependencies>",
    ),
  );
  assert.equal(resolveJavaToolingPin(root).kind, "none");
});

test("the app-parent pin wins over the codegen plugin's", () => {
  writeFileSync(join(root, "pom.xml"), parentPom("0.10.0").replace("</project>", `${pluginPom("0.9.1").slice(9)}`));
  assert.deepEqual(resolveJavaToolingPin(root), { kind: "pinned", version: "0.10.0", source: "app-parent" });
});

test("without an app parent, the codegen plugin's version is the pin", () => {
  writeFileSync(join(root, "pom.xml"), pluginPom("0.9.1"));
  assert.deepEqual(resolveJavaToolingPin(root), { kind: "pinned", version: "0.9.1", source: "codegen-plugin" });
});

test("a property reference in the parent version is resolved within the pom", () => {
  writeFileSync(join(root, "pom.xml"), parentPom("${tooling}", "<properties><tooling>0.10.2</tooling></properties>"));
  assert.deepEqual(resolveJavaToolingPin(root), { kind: "pinned", version: "0.10.2", source: "app-parent" });
});

test("an unresolvable parent version, a missing pom and an unpinned pom each say why", () => {
  writeFileSync(join(root, "pom.xml"), parentPom("${nowhere}"));
  const unresolved = resolveJavaToolingPin(root);
  assert.equal(unresolved.kind, "none");
  assert.match(unresolved.kind === "none" ? unresolved.reason : "", /not a concrete version/);

  writeFileSync(join(root, "pom.xml"), "<project/>");
  const unpinned = resolveJavaToolingPin(root);
  assert.match(unpinned.kind === "none" ? unpinned.reason : "", /no tooling version is pinned/);

  rmSync(join(root, "pom.xml"));
  const missing = resolveJavaToolingPin(root);
  assert.match(missing.kind === "none" ? missing.reason : "", /no readable pom\.xml/);
});

test("the installed @exeris/codegen-ts is the TypeScript pin", () => {
  installCodegenTs("0.10.0");
  assert.deepEqual(resolveTypeScriptToolingPin(root), { kind: "pinned", version: "0.10.0", source: "node-modules" });
});

test("no installed @exeris/codegen-ts is no TypeScript pin", () => {
  assert.equal(resolveTypeScriptToolingPin(root).kind, "none");
});

test("the project pin prefers Maven and falls back to the installed TypeScript generator", () => {
  installCodegenTs("0.8.0");
  writeFileSync(join(root, "pom.xml"), parentPom("0.10.0"));
  assert.deepEqual(resolveProjectToolingVersion(root), { kind: "pinned", version: "0.10.0", source: "app-parent" });

  rmSync(join(root, "pom.xml"));
  assert.deepEqual(resolveProjectToolingVersion(root), { kind: "pinned", version: "0.8.0", source: "node-modules" });
});

test("a project with no pin at all reports the Maven reason", () => {
  writeFileSync(join(root, "pom.xml"), "<project/>");
  const pin = resolveProjectToolingVersion(root);
  assert.equal(pin.kind, "none");
  assert.match(pin.kind === "none" ? pin.reason : "", /no tooling version is pinned/);
});
