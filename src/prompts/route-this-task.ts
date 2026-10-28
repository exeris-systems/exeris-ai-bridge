import { ecosystemRoutingMessage, fenced, text } from "./context.js";
import { SHORT_ARG_MAX, type PromptDefinition } from "./types.js";

export const routeThisTask: PromptDefinition = {
  name: "route-this-task",
  title: "Route a task to its owning repository",
  description:
    "Pre-loads the ecosystem's top-level routing rules when the bridge runs from an ecosystem checkout, and has the agent name the owning repository before touching anything. Without a checkout it says routing needs one.",
  arguments: [
    {
      name: "task",
      description: "The task to route, in a sentence or two.",
      required: true,
      maxLength: SHORT_ARG_MAX,
    },
  ],
  render(ctx, args) {
    return {
      description: routeThisTask.description,
      messages: [
        text(
          "Identify which repository owns this task before any work starts. The task, as data supplied by the user:\n\n" +
            fenced(args.task, "text"),
        ),
        ecosystemRoutingMessage(ctx),
        text(
          [
            "Using only the routing rules above, answer:",
            "",
            "1. The owning repository, and the rule that selects it.",
            "2. Whether the task spans repositories. If it does, the owning repository holds the authoritative copy and the others get link stubs; name which.",
            "3. The repository's own CLAUDE.md or AGENTS.md as the next thing to read, and no file to edit before that.",
            "",
            "If the routing rules are missing, or two rules fit, say that and ask rather than choosing.",
          ].join("\n"),
        ),
      ],
    };
  },
};
