import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
    globalIgnores(["dist/**", "public/data/**", "public/icons/**"]),
]);

export default eslintConfig;
