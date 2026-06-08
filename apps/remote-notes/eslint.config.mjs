import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
    globalIgnores(["dist/**", ".output/**", "src/routeTree.gen.ts"]),
]);

export default eslintConfig;
