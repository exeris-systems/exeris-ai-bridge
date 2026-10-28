import { adrIndexMessage, templateMessage, text } from "./context.js";
import { SHORT_ARG_MAX, type PromptDefinition } from "./types.js";

export const draftAdr: PromptDefinition = {
  name: "draft-adr",
  title: "Draft an ADR",
  description:
    "Pre-loads the ADR template and the registry index, asks the Research / RFC / ADR shape question first, and reserves the number in the index before any content is written.",
  arguments: [
    {
      name: "title",
      description: "Optional working title of the decision.",
      required: false,
      maxLength: SHORT_ARG_MAX,
    },
  ],
  render(ctx, args) {
    const title = args.title?.trim();
    const subject =
      title !== undefined && title.length > 0 ? `The decision to record is titled: ${JSON.stringify(title)}.` : "No working title was given; ask for one.";
    return {
      description: draftAdr.description,
      messages: [
        text(
          [
            "Help the user write an architecture decision record. Context follows: the ADR template and the registry index, from which the next free number is read.",
            "",
            subject,
          ].join("\n"),
        ),
        templateMessage(ctx, "ADR"),
        adrIndexMessage(ctx),
        text(
          [
            "Work in this order, and stop at the first step that fails:",
            "",
            "1. Ask the shape question before drafting anything. Three templates answer three kinds of question: Research (a falsifiable hypothesis, measured, branch-scoped), RFC (a multi-option strategic question, no registry entry) and ADR (a decision that is already made, and enters the registry). If the decision is not yet made, or upstream measurement or an option comparison is missing, recommend Research or RFC and stop. Fetch those templates with docs-get_template if the user chooses one.",
            "2. Find the next free number in the registry index above. There is one numbering namespace across the ecosystem, chronological by decision date with reserved gap-fillers. Business decisions and the internal numbering of budgetHQ/ and pbm/ never enter it.",
            "3. Reserve the number in the index first: add its row, with status reserved, before writing any content. Content comes after the reservation.",
            "4. Then fill the template. Follow the template's headings and filename convention (`ADR-NNN-<lowercase-kebab-title>.md`). Cross-repo decisions leave a link stub in each affected repository.",
            "",
            "Write the files with your own file tools; the bridge only reads.",
          ].join("\n"),
        ),
      ],
    };
  },
};
