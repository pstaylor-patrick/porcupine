import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "infra/.terraform/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["web/**/*.mjs", "scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
);
