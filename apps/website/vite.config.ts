import { cloudflare } from "@cloudflare/vite-plugin";
import { defineAppConfig } from "@party-stack/tanstack-start-build-config";
import { fumadocsMdx } from "fumadocs-mdx/vite";

export default defineAppConfig({
    plugins: [!process.env.VITEST && cloudflare({ viteEnvironment: { name: "ssr" } }), fumadocsMdx()],
    server: { port: 4000 },
    run: { tasks: { deploy: { command: "wrangler deploy", dependsOn: ["build"], cache: false } } },
    test: { passWithNoTests: true },
});
