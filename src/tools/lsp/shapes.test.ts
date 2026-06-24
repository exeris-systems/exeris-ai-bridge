import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  LspShapeError,
  parseActionSummaries,
  parseDomainDescription,
  parseDomainSummaries,
} from "./shapes.js";

const SUMMARY = {
  qualifiedName: "com.acme.Order",
  simpleName: "Order",
  packageName: "com.acme",
  sourcePath: "/ws/com/acme/Order.java",
};

test("parseDomainSummaries accepts a valid list and keeps only contract fields", () => {
  const out = parseDomainSummaries([{ ...SUMMARY, extra: "dropped" }]);
  assert.deepEqual(out, [SUMMARY]);
});

test("parseDomainSummaries rejects a non-array result", () => {
  assert.throws(() => parseDomainSummaries({}), LspShapeError);
});

test("parseDomainSummaries pinpoints the offending field and index", () => {
  assert.throws(
    () => parseDomainSummaries([SUMMARY, { ...SUMMARY, packageName: 7 }]),
    (err: unknown) =>
      err instanceof LspShapeError && /domains\[1\]\.packageName must be a string, got number/.test(err.message),
  );
});

test("parseDomainDescription validates nested fields, actions, and artefacts", () => {
  const description = {
    ...SUMMARY,
    fields: [{ name: "total", type: "BigDecimal", required: true }],
    actions: [
      {
        name: "submit",
        httpMethod: "POST",
        resultType: "void",
        params: [{ name: "note", type: "String", required: false }],
      },
    ],
    artefacts: ["rest", "events"],
  };
  assert.deepEqual(parseDomainDescription(description), description);
});

test("parseDomainDescription reports a bad param boolean with a full path", () => {
  const description = {
    ...SUMMARY,
    fields: [],
    actions: [
      { name: "submit", httpMethod: "POST", resultType: "void", params: [{ name: "n", type: "String", required: "yes" }] },
    ],
    artefacts: [],
  };
  assert.throws(
    () => parseDomainDescription(description),
    (err: unknown) =>
      err instanceof LspShapeError &&
      /domain\.actions\[0\]\.params\[0\]\.required must be a boolean, got string/.test(err.message),
  );
});

test("parseDomainDescription rejects a non-string artefact entry", () => {
  assert.throws(
    () => parseDomainDescription({ ...SUMMARY, fields: [], actions: [], artefacts: ["rest", 3] }),
    (err: unknown) => err instanceof LspShapeError && /domain\.artefacts\[1\] must be a string/.test(err.message),
  );
});

test("parseActionSummaries validates the owning domain and params", () => {
  const actions = [
    {
      owningDomain: "com.acme.Order",
      name: "submit",
      httpMethod: "POST",
      resultType: "void",
      params: [{ name: "note", type: "String", required: false }],
    },
  ];
  assert.deepEqual(parseActionSummaries(actions), actions);
});

test("parseActionSummaries normalizes absent/null httpMethod and resultType to null", () => {
  // A void, non-HTTP action: the server (LSP4J/Gson) omits the null String fields.
  const out = parseActionSummaries([
    { owningDomain: "com.acme.Order", name: "recalculate", params: [] },
  ]);
  assert.deepEqual(out, [
    {
      owningDomain: "com.acme.Order",
      name: "recalculate",
      httpMethod: null,
      resultType: null,
      params: [],
    },
  ]);
});

test("parseDomainDescription normalizes a void action's resultType to null", () => {
  const description = {
    qualifiedName: "com.acme.Order",
    simpleName: "Order",
    packageName: "com.acme",
    sourcePath: "/ws/Order.java",
    fields: [],
    actions: [{ name: "submit", httpMethod: "POST", params: [] }], // resultType omitted (void)
    artefacts: [],
  };
  const out = parseDomainDescription(description);
  assert.equal(out.actions[0].resultType, null);
  assert.equal(out.actions[0].httpMethod, "POST");
});

test("parseActionSummaries rejects a missing owningDomain", () => {
  assert.throws(
    () =>
      parseActionSummaries([{ name: "submit", httpMethod: "POST", resultType: "void", params: [] }]),
    (err: unknown) =>
      err instanceof LspShapeError && /actions\[0\]\.owningDomain must be a string, got undefined/.test(err.message),
  );
});
