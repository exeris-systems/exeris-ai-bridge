import { deprecationsMessage, fenced, text } from "./context.js";
import { SHORT_ARG_MAX, type PromptDefinition } from "./types.js";

export const migrateSdkVersion: PromptDefinition = {
  name: "migrate-sdk-version",
  title: "Find what the next SDK bump will break",
  description:
    "Pre-loads the SDK deprecation list and has the agent find the usages in the project that the next SDK bump will break. Runs without a local server.",
  arguments: [
    {
      name: "targetVersion",
      description: "Optional SDK version to migrate to.",
      required: false,
      maxLength: SHORT_ARG_MAX,
    },
  ],
  render(ctx, args) {
    const target = args.targetVersion?.trim();
    const subject =
      target !== undefined && target.length > 0
        ? "The target SDK version, as data supplied by the user:\n\n" + fenced(target, "text")
        : "No target version was given; assume the next release and say so.";
    return {
      description: migrateSdkVersion.description,
      messages: [
        text("Find the usages in the user's project that the next SDK bump will break.\n\n" + subject),
        deprecationsMessage(ctx),
        text(
          [
            "1. Take the deprecation list above. Items with `forRemoval: true` break on a bump; the others warn. The list reflects the SDK version in the bundled data; the `sdk-*` tools report any skew against the project's pinned version, and `sdk-list_deprecations` can be called with `forRemovalOnly` to narrow it.",
            "2. Search the project's sources for each deprecated annotation and attribute, by name, with your own search tools. Include generated-source configuration and build files, not only `src/main`.",
            "3. For each usage give file, line, the replacement from the list, and whether the replacement keeps behaviour. Where the list gives no replacement, say so; do not invent one.",
            "4. Order the result by `forRemoval` first, and state which parts of the project you searched, so an empty result is distinguishable from an unfinished search.",
            "5. Do not change the SDK version in the build files until the user has seen the list.",
          ].join("\n"),
        ),
      ],
    };
  },
};
