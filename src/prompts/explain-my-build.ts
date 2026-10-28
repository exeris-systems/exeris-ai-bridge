import { NEEDS_LOCAL_SERVER, text } from "./context.js";
import type { PromptDefinition } from "./types.js";

export const explainMyBuild: PromptDefinition = {
  name: "explain-my-build",
  title: "Explain what this build produced",
  description:
    "Has the agent call build-explain_artefacts and build-get_detach_state to answer what the build produced and which of it may be edited. Both steps need a local server.",
  arguments: [],
  render() {
    return {
      description: explainMyBuild.description,
      messages: [
        text(
          [
            "Answer two questions about the user's project: what did this build produce, and which of it may I edit?",
            "",
            "1. Call `build-explain_artefacts`. It lists the files codegen emitted, each with the generator that produced it and when that generator emits. A path with several candidate generators is shared; report it as such rather than picking one. If it answers `present: false`, the project has not run codegen; say so and stop.",
            "2. Call `build-get_detach_state`. It reports whether the generated code is still pipeline-owned (regenerated on every build, so edits are lost) or has been detached into the developer's own sources (owned, safe to edit), with the observations behind that state.",
            "3. Combine them. For every group of files say what produced it, and whether editing it is safe: pipeline-owned generated code is regenerated on every build, so the change belongs in the source model; detached code is owned by the user.",
            "4. Report any tooling skew the first call carries, since an explanation from another tooling release can differ from what built the project.",
            "",
            NEEDS_LOCAL_SERVER + " Do not answer from the generator's general behaviour when the tools are unavailable.",
          ].join("\n"),
        ),
      ],
    };
  },
};
