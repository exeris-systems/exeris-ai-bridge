import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseAnnotationCatalog, parseAstSchema } from "./shapes.js";

const VALID_CATALOG = {
  catalogFormat: 1,
  sdkVersion: "0.12.0-SNAPSHOT",
  annotationCount: 1,
  packages: [
    {
      name: "eu.exeris.sdk.annotation",
      purpose: "Root annotation package",
      description: "Description of root package",
    },
  ],
  annotations: [
    {
      name: "Action",
      qualifiedName: "eu.exeris.sdk.annotation.Action",
      package: "eu.exeris.sdk.annotation",
      nested: false,
      targets: ["METHOD"],
      memberValueOnly: false,
      retention: "SOURCE",
      purpose: "Exposes domain methods as API endpoints",
      description: "Detailed Action description",
      attributes: [
        {
          name: "name",
          type: "java.lang.String",
          required: true,
          purpose: "Action name",
        },
        {
          name: "path",
          type: "java.lang.String",
          required: false,
          default: '""',
          purpose: "URL path",
          deprecated: {
            forRemoval: true,
            since: "0.11.0",
            replacement: "Derived route",
          },
        },
      ],
    },
  ],
};

const VALID_AST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://exeris.eu/schema/sdk/ast/0.12.0.json",
  title: "Exeris SDK AST",
  description: "Metadata AST format",
  schemaFormat: 1,
  sdkVersion: "0.12.0-SNAPSHOT",
  astSchemaVersion: "0.12.0",
  definitionCount: 2,
  "x-exeris-reader-requirements": [
    {
      id: "FAIL_ON_NULL_FOR_PRIMITIVES",
      statement: "Reader obligation",
    },
  ],
  $defs: {
    DomainMetadata: {
      type: "object",
      description: "Root domain metadata",
    },
    FieldMetadata: {
      type: "object",
      description: "Field metadata",
    },
  },
};

test("parseAnnotationCatalog parses valid catalog and preserves contract fields", () => {
  const catalog = parseAnnotationCatalog(VALID_CATALOG);
  assert.equal(catalog.catalogFormat, 1);
  assert.equal(catalog.sdkVersion, "0.12.0-SNAPSHOT");
  assert.equal(catalog.annotationCount, 1);
  assert.equal(catalog.annotations.length, 1);
  assert.equal(catalog.packages.length, 1);

  const ann = catalog.annotations[0];
  assert.equal(ann.name, "Action");
  assert.equal(ann.qualifiedName, "eu.exeris.sdk.annotation.Action");
  assert.deepEqual(ann.targets, ["METHOD"]);
  assert.equal(ann.attributes.length, 2);
  assert.equal(ann.attributes[1].deprecated?.forRemoval, true);
  assert.equal(ann.attributes[1].deprecated?.since, "0.11.0");
});

test("parseAnnotationCatalog rejects invalid catalogFormat", () => {
  assert.throws(
    () => parseAnnotationCatalog({ ...VALID_CATALOG, catalogFormat: 2 }),
    /catalogFormat: 2; expected 1/,
  );
});

test("parseAnnotationCatalog rejects missing sdkVersion", () => {
  assert.throws(
    () => parseAnnotationCatalog({ ...VALID_CATALOG, sdkVersion: "" }),
    /Missing or invalid sdkVersion/,
  );
});

test("parseAnnotationCatalog rejects non-array annotations", () => {
  assert.throws(
    () => parseAnnotationCatalog({ ...VALID_CATALOG, annotations: null }),
    /Missing or invalid annotations array/,
  );
});

test("parseAstSchema parses envelope and definitions", () => {
  const parsed = parseAstSchema(VALID_AST_SCHEMA);
  assert.equal(parsed.envelope.schemaFormat, 1);
  assert.equal(parsed.envelope.sdkVersion, "0.12.0-SNAPSHOT");
  assert.equal(parsed.envelope.astSchemaVersion, "0.12.0");
  assert.deepEqual(parsed.envelope.definitions, ["DomainMetadata", "FieldMetadata"]);
  assert.equal(parsed.definitions.DomainMetadata.description, "Root domain metadata");
});

test("parseAstSchema rejects unsupported schemaFormat", () => {
  assert.throws(
    () => parseAstSchema({ ...VALID_AST_SCHEMA, schemaFormat: 99 }),
    /Unsupported or missing schemaFormat: 99; expected 1/,
  );
});
