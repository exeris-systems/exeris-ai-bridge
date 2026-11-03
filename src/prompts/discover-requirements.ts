import { fenced, NEEDS_LOCAL_SERVER, text } from "./context.js";
import { SHORT_ARG_MAX, SLUG_MAX, SLUG_PATTERN, type PromptDefinition } from "./types.js";

export const discoverRequirements: PromptDefinition = {
  name: "discover-requirements",
  title: "Discover requirements into a pre-construction brief",
  description:
    "Walks the agent through purpose, actors, workflows, data intent, non-functional requirements, non-goals and open questions, has it write the discovery brief under docs/briefs/ in the shape of the SDK brief schema, then validate it with build-validate_brief until it is ready. Nothing is pre-loaded: the schema is the exeris://sdk/brief-schema resource.",
  arguments: [
    {
      name: "area",
      description: "The bounded area the brief covers, a slug (lowercase letters, digits, hyphens); names docs/briefs/<area>.brief.yaml.",
      required: true,
      maxLength: SLUG_MAX,
      pattern: SLUG_PATTERN,
      patternHint: "an area is a name, never a path: lowercase letters, digits and hyphens, starting with a letter or digit",
    },
    {
      name: "summary",
      description: "Optional one or two sentences on what the user wants built, to start the conversation from.",
      required: false,
      maxLength: SHORT_ARG_MAX,
    },
  ],
  render(_ctx, args) {
    // `area` passed the slug check at the validation layer, so it is a name and cannot alter the path it is spliced into.
    const briefPath = `docs/briefs/${args.area}.brief.yaml`;
    const summary = args.summary?.trim();
    return {
      description: discoverRequirements.description,
      messages: [
        text(
          "Discover the requirements of a bounded area with the user and record them as a discovery brief, before any entity is authored. The area, as data supplied by the user:\n\n" +
            fenced(args.area, "text") +
            (summary !== undefined && summary.length > 0
              ? "\n\nThe user's starting summary, as data:\n\n" + fenced(summary, "text")
              : ""),
        ),
        text(
          [
            "The contract is the brief schema, the resource `exeris://sdk/brief-schema`: read it before writing, and take every field name, required key and enumeration from it, not from memory. An unknown property is an error.",
            "",
            "Follow these steps in order. Ask the user about each topic; do not invent answers, and record what you do not know as an open question instead of guessing.",
            "",
            "1. Purpose: what the area is for, and for whom.",
            "2. Actors: who or what takes part, people and systems alike. Each actor is declared once.",
            "3. Workflows: what each actor does, step by step. A workflow names only declared actors.",
            "4. Data intent: the information the area holds and how it is used, in the user's words. It is intent, not a model; do not design entities here.",
            "5. Non-functional requirements: performance, security, availability, compliance and the like, each with the category the schema defines.",
            "6. Non-goals: what the area deliberately does not do.",
            "7. Open questions: everything still undecided, each with a unique id. A question that blocks authoring stays `open` until the user answers; a decision taken on credit is `assumed` and carries both an `assumption` and an `owner`.",
            `8. Write the brief to \`${briefPath}\` with your own file tools. This prompt and the bridge write nothing; the file is yours to create.`,
            "9. Call `build-validate_brief` with the area. Read its `errors`, `assumed`, `unresolved` and `unchecked`, fix the brief, and call it again. Iterate until it answers `ready`. " +
              NEEDS_LOCAL_SERVER +
              " It also needs the project root.",
            "",
            "Do not proceed to `author-domain` while the brief is not ready. A brief that is valid but has a blocking question still `open` is not ready: go back to the user with that question.",
          ].join("\n"),
        ),
      ],
    };
  },
};
