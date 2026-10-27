import { defineAppConfig } from "@party-stack/tanstack-start-build-config";
import { fumadocsMdx } from "fumadocs-mdx/vite";

export default defineAppConfig({
    plugins: [fumadocsMdx()],
    server: { port: 4000 },
    test: { passWithNoTests: true },
});
