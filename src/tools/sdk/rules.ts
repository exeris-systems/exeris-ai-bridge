// Canonical scoping rules for the Exeris SDK authoring contract.
// Grounded in package-info.java (eu.exeris.sdk.annotation) and ADR-054.

export interface ScopingRule {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly details: Record<string, unknown>;
}

export const CANONICAL_SCOPING_RULES: readonly ScopingRule[] = [
  {
    id: "field-vs-validation-split",
    title: "@Field vs @Validation — Canonical Scoping Split",
    summary:
      "@Field describes what a field IS (data shape, persistence, form lifecycle); @Validation is the sole declaration site of constraint rules.",
    details: {
      fieldScope: {
        annotation: "@Field",
        concept: "Data shape, persistence, and form lifecycle",
        canonicalAttributes: [
          "label",
          "required",
          "unique",
          "indexed",
          "readOnly",
          "computed",
          "computedFrom",
          "inCreate",
          "inUpdate",
          "sortable",
          "filterable",
        ],
        rule: "No validation constraint attributes belong on @Field.",
      },
      validationScope: {
        annotation: "@Validation",
        concept: "Validation constraints only",
        canonicalAttributes: [
          "min",
          "max",
          "minLength",
          "maxLength",
          "pattern",
          "email",
          "url",
          "future",
          "past",
        ],
        rule: "No form-lifecycle or persistence attributes belong on @Validation.",
      },
      bindingUniversalRule:
        "This split binds all annotations, not only these two. For example, @Blob declares a binary-object facet and deliberately carries no maxSizeBytes — size bounds belong on @Validation.",
    },
  },
  {
    id: "single-ast-carrier",
    title: "FieldMetadata as the Single AST Carrier",
    summary:
      "Both @Field and @Validation map into a single FieldMetadata record in the DomainMetadata AST. There is no parallel validation record (ADR-054).",
    details: {
      carrierRecord: "eu.exeris.sdk.sourcemodel.ast.FieldMetadata",
      astContext: "DomainMetadata.fields[]",
      rationale:
        "ADR-054 removed the parallel validation record in SDK 0.9.0. Constraints and field shape are unified in FieldMetadata at build time. Code generators read this single carrier.",
    },
  },
  {
    id: "derived-nullability-semantics",
    title: "Derived NOT NULL and Not-Blank Semantics",
    summary:
      "Database NOT NULL constraints and API not-blank requirements are derived from FieldMetadata.required at generator level, never separately declared.",
    details: {
      sqlGenerator:
        "Emits NOT NULL column constraint when FieldMetadata.required is true (unless computed or generated).",
      openApiGenerator:
        "Includes the property in the schema's 'required' array when FieldMetadata.required is true.",
      handlerGenerator:
        "Enforces presence validation on incoming create/update payloads before executing domain actions.",
    },
  },
  {
    id: "form-lifecycle-scoping",
    title: "Form Lifecycle Scoping (@Field.inCreate / @Field.inUpdate)",
    summary:
      "Whether a field participates in create/update operations is controlled by @Field.inCreate() and @Field.inUpdate(), NOT @Validation.validateOn.",
    details: {
      inCreate:
        "boolean (default true): whether this field appears on the create form and is accepted during entity creation.",
      inUpdate:
        "boolean (default true): whether this field appears on the edit form and is accepted during entity update.",
      readOnly:
        "boolean (default false): when true, field cannot be updated after creation (equivalent to inCreate=true, inUpdate=false).",
    },
  },
  {
    id: "deprecation-fallbacks",
    title: "Deprecated Validation Attributes with Processor Fallback",
    summary:
      "Two legacy @Validation attributes are deprecated-for-removal in 1.0.0 and must not be written in new code.",
    details: {
      fallbacks: [
        {
          deprecatedAttribute: "@Validation.required",
          replacement: "@Field(required = true)",
          removalRelease: "1.0.0",
          rationale:
            "Required-ness is an ontological property of the field shape, not a validation constraint rule.",
        },
        {
          deprecatedAttribute: "@Validation.validateOn",
          replacement: "@Field(inCreate = ..., inUpdate = ...)",
          removalRelease: "1.0.0",
          rationale:
            "Form lifecycle scope belongs on @Field: a field absent from creation (inCreate=false) should not have create-scoped validation rules.",
        },
      ],
      processorBehavior:
        "During the deprecation window, the processor reads both legacy attributes as a fallback when the @Field counterpart is unset, emitting a compiler warning.",
    },
  },
  {
    id: "nested-form-trap",
    title: "The Sibling Form vs Nested Form Trap",
    summary:
      "Annotations must be written as SIBLINGS (@Field(...) @Validation(...)), NEVER nested (@Field(validation = @Validation(...))).",
    details: {
      siblingForm:
        "@Field(label = \"Email\") @Validation(email = true) private String email; (READ — reaches AST)",
      nestedForm:
        "@Field(label = \"Email\", validation = @Validation(email = true)) private String email; (NO-OP — compiles clean, read by nobody)",
      reason:
        "Both the annotation processor and the SDK -io reader walk directly present annotations on the element. Nested annotation members are unread.",
    },
  },
];

export function findScopingRules(query?: string): ScopingRule[] {
  if (!query || query.trim().length === 0) {
    return [...CANONICAL_SCOPING_RULES];
  }
  const q = query.trim().toLowerCase();
  return CANONICAL_SCOPING_RULES.filter(
    (rule) =>
      rule.id.toLowerCase().includes(q) ||
      rule.title.toLowerCase().includes(q) ||
      rule.summary.toLowerCase().includes(q) ||
      JSON.stringify(rule.details).toLowerCase().includes(q),
  );
}
