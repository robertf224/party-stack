import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
    globalIgnores([
        "dist/**",
        ".output/**",
        ".next/**",
        "src/routeTree.gen.ts",
    ]),
]);

export default eslintConfig;
