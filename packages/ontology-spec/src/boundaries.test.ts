import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Inspect published JS: type-only imports must not pull live/runtime or Node tooling. */
describe("spec package boundary", () => {
    it("keeps the runtime entry points independent of live ontology and codegen", async () => {
        const external = new Set<string>();
        const visited = new Set<string>();
        const visit = async (url: URL) => {
            if (visited.has(url.href)) return;
            visited.add(url.href);
            const text = await readFile(url, "utf8");
            for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)) {
                const name = match[1]!;
                if (name.startsWith(".")) await visit(new URL(name, url));
                else external.add(name);
            }
        };
        for (const entry of ["index.js", "json/index.js", "meta/index.js", "query/index.js"])
            await visit(new URL(`../lib/${entry}`, import.meta.url));
        expect(
            [...external].filter(
                (name) =>
                    name === "@party-stack/ontology" ||
                    name === "effect" ||
                    name.startsWith("effect/") ||
                    name.startsWith("@tanstack/") ||
                    name.startsWith("node:") ||
                    [
                        "@party-stack/runtime",
                        "@party-stack/node-runtime",
                        "effection",
                        "ts-morph",
                        "oxfmt",
                        "commander",
                        "jiti",
                    ].includes(name)
            )
        ).toEqual([]);
        expect([...visited].some((path) => /\/(generate|cli|live)\//.test(path))).toBe(false);
    });
});
