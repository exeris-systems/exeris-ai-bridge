import type { GetPromptResult, Prompt } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import type { BundleState } from "../data/bundle.js";

/** What a prompt may read: the docs configuration and the bundled SDK data, never a process or the network. */
export interface PromptContext {
  readonly config: BridgeConfig;
  readonly bundle: BundleState;
  /** Where the bundle's files are read from; the packaged location when absent. Injectable for tests. */
  readonly bundleRoot?: string;
}

/** One declared argument. `maxLength` is in characters and is enforced before the prompt renders. */
export interface PromptArgumentSpec {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly maxLength: number;
}

export interface PromptDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly PromptArgumentSpec[];
  /** Build the messages from the template and the validated arguments. */
  readonly render: (ctx: PromptContext, args: Readonly<Record<string, string>>) => GetPromptResult;
}

export function toListedPrompt(def: PromptDefinition): Prompt {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    arguments: def.arguments.map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required,
    })),
  };
}

/** Argument bounds, in characters. */
export const SHORT_ARG_MAX = 256;
export const LONG_ARG_MAX = 65_536;
