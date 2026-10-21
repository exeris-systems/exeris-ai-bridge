import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  LspShapeError,
  parseActionSummaries,
  parseDomainDescription,
  parseDomainSummaries,
  parseMutationPreview,
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

test("parseDomainDescription preserves absent relationships facet as absent (undefined)", () => {
  const desc = {
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
  };
  const out = parseDomainDescription(desc);
  assert.equal(out.relationships, undefined);
  assert.equal("relationships" in out, false);
});

test("parseDomainDescription preserves empty relationships as empty array []", () => {
  const desc = {
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
    relationships: [],
  };
  const out = parseDomainDescription(desc);
  assert.deepEqual(out.relationships, []);
});

test("parseDomainDescription preserves null relationships as null", () => {
  const desc = {
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
    relationships: null,
  };
  const out = parseDomainDescription(desc);
  assert.equal(out.relationships, null);
});

test("parseDomainDescription parses valid relationships with and without type", () => {
  const desc = {
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
    relationships: [
      { name: "items", targetEntity: "OrderItem", type: "ONE_TO_MANY" },
      { name: "parent", targetEntity: "OrderGroup" }, // type omitted/null
      { name: "audit", targetEntity: "AuditLog", type: null },
    ],
  };
  const out = parseDomainDescription(desc);
  assert.deepEqual(out.relationships, [
    { name: "items", targetEntity: "OrderItem", type: "ONE_TO_MANY" },
    { name: "parent", targetEntity: "OrderGroup", type: null },
    { name: "audit", targetEntity: "AuditLog", type: null },
  ]);
});

test("parseDomainDescription rejects malformed relationships", () => {
  assert.throws(
    () =>
      parseDomainDescription({
        ...SUMMARY,
        fields: [],
        actions: [],
        artefacts: [],
        relationships: "not-an-array",
      }),
    (err: unknown) => err instanceof LspShapeError && /domain\.relationships must be an array/.test(err.message),
  );

  assert.throws(
    () =>
      parseDomainDescription({
        ...SUMMARY,
        fields: [],
        actions: [],
        artefacts: [],
        relationships: [{ name: 123, targetEntity: "Item" }],
      }),
    (err: unknown) =>
      err instanceof LspShapeError && /domain\.relationships\[0\]\.name must be a string/.test(err.message),
  );

  assert.throws(
    () =>
      parseDomainDescription({
        ...SUMMARY,
        fields: [],
        actions: [],
        artefacts: [],
        relationships: [{ name: "items", targetEntity: 456 }],
      }),
    (err: unknown) =>
      err instanceof LspShapeError && /domain\.relationships\[0\]\.targetEntity must be a string/.test(err.message),
  );

  assert.throws(
    () =>
      parseDomainDescription({
        ...SUMMARY,
        fields: [],
        actions: [],
        artefacts: [],
        relationships: [{ name: "items", targetEntity: "Item", type: 789 }],
      }),
    (err: unknown) =>
      err instanceof LspShapeError && /domain\.relationships\[0\]\.type must be a string/.test(err.message),
  );
});

test("parseDomainDescription handles sourceDigest: absent, string, null, and rejects non-string", () => {
  // Absent
  const outAbsent = parseDomainDescription({
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
  });
  assert.equal(outAbsent.sourceDigest, undefined);
  assert.equal("sourceDigest" in outAbsent, false);

  // Present string
  const outString = parseDomainDescription({
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
    sourceDigest: "sha256:0123456789abcdef",
  });
  assert.equal(outString.sourceDigest, "sha256:0123456789abcdef");

  // Null
  const outNull = parseDomainDescription({
    ...SUMMARY,
    fields: [],
    actions: [],
    artefacts: [],
    sourceDigest: null,
  });
  assert.equal(outNull.sourceDigest, null);

  // Invalid type
  assert.throws(
    () =>
      parseDomainDescription({
        ...SUMMARY,
        fields: [],
        actions: [],
        artefacts: [],
        sourceDigest: 42,
      }),
    (err: unknown) => err instanceof LspShapeError && /domain\.sourceDigest must be a string/.test(err.message),
  );
});

test("parseMutationPreview parses a valid SUCCESS outcome preview", () => {
  const payload = {
    result: {
      outcome: "SUCCESS",
      path: "/entities/Order/fields/priority",
    },
    sourcePath: "file:///workspace/src/main/java/com/acme/Order.java",
    diff: "--- a/Order.java\n+++ b/Order.java\n@@ -5,1 +5,2 @@\n+    private String priority;\n",
  };
  const out = parseMutationPreview(payload);
  assert.deepEqual(out, payload);
});

test("parseMutationPreview handles non-SUCCESS outcomes with empty diff and null sourcePath", () => {
  for (const result of [
    { outcome: "CONFLICT", path: "/entities/Order/fields/total", baselineValue: "a", currentValue: "b", intendedValue: "c" },
    { outcome: "VALIDATION_ERROR", path: "/entities/Order/fields/missing", message: "no such field" },
    { outcome: "NO_BASELINE", cause: "STALE_DIGEST", detail: "sourceDigest does not match" },
  ]) {
    const payload = {
      result,
      diff: "",
    };
    const out = parseMutationPreview(payload);
    assert.deepEqual(out, {
      result,
      sourcePath: null,
      diff: "",
    });
  }
});

test("parseMutationPreview rejects malformed payloads", () => {
  assert.throws(
    () => parseMutationPreview("not-an-object"),
    (err: unknown) => err instanceof LspShapeError && /preview must be an object/.test(err.message),
  );

  assert.throws(
    () => parseMutationPreview({ diff: "" }),
    (err: unknown) => err instanceof LspShapeError && /preview\.result must be an object/.test(err.message),
  );

  assert.throws(
    () => parseMutationPreview({ result: { outcome: 123 }, diff: "" }),
    (err: unknown) => err instanceof LspShapeError && /preview\.result\.outcome must be a string/.test(err.message),
  );

  assert.throws(
    () => parseMutationPreview({ result: { outcome: "SUCCESS" } }),
    (err: unknown) => err instanceof LspShapeError && /preview\.diff must be a string/.test(err.message),
  );

  assert.throws(
    () => parseMutationPreview({ result: { outcome: "SUCCESS" }, diff: 123 }),
    (err: unknown) => err instanceof LspShapeError && /preview\.diff must be a string/.test(err.message),
  );

  assert.throws(
    () => parseMutationPreview({ result: { outcome: "SUCCESS" }, diff: "", sourcePath: 999 }),
    (err: unknown) => err instanceof LspShapeError && /preview\.sourcePath must be a string/.test(err.message),
  );
});

