import base from "@bobbyfidz/universal-build-config/eslint-base.mjs";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
    globalIgnores([
        "**/lib/**",
    ]),
    ...base,
]);
