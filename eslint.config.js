import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "caddy/data/**", "caddy/config/**", "infra/.terraform/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["web/**/*.mjs"], languageOptions: { globals: globals.node } },
);
