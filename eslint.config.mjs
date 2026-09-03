// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Lint config for a repository that already runs `tsc` in strict mode with
// noUnusedLocals, noUnusedParameters and noImplicitReturns. That settles most
// of what a stylistic linter would catch, so this exists for the class of
// defect the compiler is not looking for: a promise nobody awaited, a value
// that has quietly become `any` and stopped being checked, an assertion that
// asserts nothing.
//
// Which means TYPE-AWARE linting or nothing. An untyped rule set would mostly
// restate the compiler, and the rule most worth having in a server whose every
// tool handler is async — no-floating-promises — cannot be expressed without
// types.

export default tseslint.config(
  {
    // Generated and vendored trees. `dist/` is compiler output, `data/` is the
    // reference bundle `prepack` rebuilds, `coverage/` is a report. None of the
    // three is authored here and none is committed.
    ignores: ["dist/**", "data/**", "coverage/**", "node_modules/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The compiler already reports these, and it honours the leading
      // underscore this repo uses for a deliberately ignored parameter. Two
      // reporters for one defect is noise.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  {
    // Every tool handler satisfies `ToolHandler`, which returns
    // `Promise<CallToolResult>` because MCP awaits it. A handler that reads a
    // file synchronously still has to satisfy that signature, so `async`
    // without `await` is the contract here rather than an oversight — all
    // nineteen occurrences are this one shape. Scoped to the tool tree so the
    // rule stays live everywhere else.
    files: ["src/tools/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },

  {
    files: ["src/**/*.test.ts"],
    rules: {
      // `test()` from node:test returns a promise the RUNNER owns; not awaiting
      // it is the documented API, and every one of the 394 reports was a
      // top-level `test(...)` call. typescript-eslint's allowlist works on
      // branded types, and node:test returns a plain Promise<void>, so there is
      // no way to permit exactly those.
      "@typescript-eslint/no-floating-promises": "off",

      // A test's job here is to make claims about untyped data that crossed a
      // boundary — `JSON.parse` of a tool result, a JSON-RPC frame from a mock
      // transport. That the value is `any` before the assertion narrows it is
      // the PREMISE of the test, not a defect in it. Left on, these rules would
      // push every assertion through a cast asserting the very thing under
      // test.
      //
      // no-explicit-any goes with them rather than against them: the nine
      // remaining sites are test helpers whose signature DECLARES that boundary
      // (`payload(res): any`, `sent: any[]`), and an explicit boundary is
      // better than one that leaks in implicitly from JSON.parse.
      //
      // Nothing else is relaxed here. The genuinely wrong types these rules
      // surfaced were fixed instead: five `unknown | undefined` unions, which
      // collapse to `unknown` and were saying nothing.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  {
    // CI and release scripts: plain ESM JavaScript with no tsconfig, so the
    // type-aware rules have nothing to work from and are switched off rather
    // than left to fail on every file. The untyped set still applies.
    files: ["scripts/**/*.mjs", "*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
