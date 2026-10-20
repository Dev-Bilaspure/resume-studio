import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Browser code: the engine packages run on the server only (they pull in Node APIs and the Claude
    // Code SDK). Types are fine; the dependency-free display helpers live in @resume-studio/tailor/job.
    files: ["src/components/**", "src/lib/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@resume-studio/tailor", message: "Server only. Import types, or helpers from @resume-studio/tailor/job.", allowTypeImports: true },
            { name: "@resume-studio/llm", message: "Server only. Import types instead.", allowTypeImports: true },
          ],
          patterns: [
            { group: ["@resume-studio/tailor-*", "@resume-studio/llm/*", "@resume-studio/tailor/node"], message: "Server only.", allowTypeImports: true },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // PDF.js runtime assets copied from node_modules.
    "public/pdfjs/**",
  ]),
]);

export default eslintConfig;
