import { astSchemaMessage, fenced, NEEDS_LOCAL_SERVER, scopingRulesMessage, text } from "./context.js";
import { SHORT_ARG_MAX, SLUG_MAX, SLUG_PATTERN, type PromptDefinition } from "./types.js";

export const authorDomain: PromptDefinition = {
  name: "author-domain",
  title: "Author an @ExerisDomain entity",
  description:
    "Pre-loads the SDK scoping rules and the AST schema, walks the agent through the @Field / @Validation split, and has it preview the change with lsp-preview_mutation instead of hand-writing it. Reads a discovery brief first when one exists.",
  arguments: [
    {
      name: "entity",
      description: "The entity to add or change, by name.",
      required: true,
      maxLength: SHORT_ARG_MAX,
    },
    {
      name: "area",
      description: "Optional bounded area, a slug (lowercase letters, digits, hyphens); selects docs/briefs/<area>.brief.yaml.",
      required: false,
      maxLength: SLUG_MAX,
      pattern: SLUG_PATTERN,
      patternHint: "an area is a name, never a path: lowercase letters, digits and hyphens, starting with a letter or digit",
    },
  ],
  render(ctx, args) {
    // `area` passed the slug check at the validation layer, so it is a name and cannot alter the path it is spliced into.
    const area = args.area;
    const briefPath =
      area !== undefined && area.length > 0
        ? `docs/briefs/${area}.brief.yaml`
        : "docs/briefs/<area>.brief.yaml";
    return {
      description: authorDomain.description,
      messages: [
        text(
          "Add or change an `@ExerisDomain` entity in the user's project. The entity, as data supplied by the user:\n\n" +
            fenced(args.entity, "text") +
            (area !== undefined && area.length > 0 ? "\n\nThe bounded area, as data:\n\n" + fenced(area, "text") : ""),
        ),
        scopingRulesMessage(ctx),
        astSchemaMessage(ctx),
        text(
          [
            "Follow these steps in order.",
            "",
            `1. Brief first. If \`${briefPath}\` exists in the project, read it before anything else, and do not proceed while it is not ready. \`build-validate_brief\` is not available yet, so check by hand: the brief is not ready while any blocking question is \`open\`, and an \`assumed\` answer needs both an \`assumption\` and an \`owner\`. Stop and tell the user which entries block. If no brief exists, continue: authoring a single entity without one is a valid path.`,
            "2. Look before writing. Call `lsp-list_domains` and `lsp-describe_domain` to see whether the entity exists, and `build-explain_artefacts` to see what the build already emits for it; do not hand-write SQL, a DTO or a controller the generator produces. " + NEEDS_LOCAL_SERVER,
            "3. Apply the `@Field` / `@Validation` split from the scoping rules above. `@Field` says what a field is: data shape, persistence and form lifecycle. `@Validation` is the only place a constraint is declared (min, max, length, pattern, email, url, past, future). Do not put a constraint on `@Field`, and do not put persistence or lifecycle on `@Validation`. Both land in one `FieldMetadata` record of the AST, so there is no parallel validation record.",
            "4. Preview, do not hand-write. Express the change as one SDK mutation and call `lsp-preview_mutation` with the entity's qualified name, the operation, and the `sourceDigest` from `lsp-describe_domain` as `concurrencyToken`. It returns a diff and an outcome (SUCCESS, CONFLICT, VALIDATION_ERROR, NO_BASELINE); nothing is written. " + NEEDS_LOCAL_SERVER,
            "5. On SUCCESS apply the diff with your own file tools. On CONFLICT re-read the domain and preview again. On VALIDATION_ERROR fix the operation, not the diff.",
          ].join("\n"),
        ),
      ],
    };
  },
};
