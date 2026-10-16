import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
    globalIgnores(["**/dist/**", "**/coverage/**", "**/.scratch/**", "**/.pi/**", "**/.docs/**"]),
    {
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}"],
        extends: [js.configs.recommended],
        languageOptions: {
            globals: globals.node,
        },
        linterOptions: {
            reportUnusedDisableDirectives: "error",
        },
        rules: {
            // Terminal renderers and their fixtures deliberately match ANSI and control bytes.
            "no-control-regex": "off",
        },
    },
    {
        files: ["**/*.{ts,tsx,mts,cts}"],
        extends: [tseslint.configs.recommended],
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },
);
