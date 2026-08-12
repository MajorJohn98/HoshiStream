import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/stremio-addon-sdk.d.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
  },
  {
    files: ["assets/manage/**/*.js"],
    languageOptions: { globals: globals.browser },
    rules: {
      // Rest-destructuring is used to strip fields from API objects.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true },
      ],
    },
  },
);
