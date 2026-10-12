import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { formatGeneratedFile } from "./format.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

async function createDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "ontology-format-"));
    directories.push(directory);
    return directory;
}

describe("generated file formatting", () => {
    it("uses a fixed style regardless of consumer configuration", async () => {
        const directory = await createDirectory();
        const app = join(directory, "app");
        await mkdir(app);
        const input = "export const value = {\nname: 'test',\n};";
        const before = await formatGeneratedFile(join(app, "generated/types.ts"), input);
        await writeFile(join(directory, "vite.config.ts"), "throw new Error('must not load Vite config');");
        await writeFile(join(app, ".oxfmtrc.json"), JSON.stringify({ tabWidth: 2, singleQuote: true }));
        await writeFile(join(app, ".editorconfig"), "[*]\nindent_size = 8\n");
        const after = await formatGeneratedFile(join(app, "generated/types.ts"), input);
        expect(after).toBe(before);
        expect(after).toContain('    name: "test",');
        expect(after).toMatch(/^\/\/ Auto-generated file - do not edit manually\n\nexport/);
    });

    it("preserves generator import order", async () => {
        const directory = await createDirectory();
        const output = await formatGeneratedFile(
            join(directory, "types.ts"),
            `import type { Z } from "z";
import { A } from "a";
export const value = A;`
        );
        expect(output.indexOf("import type { Z }")).toBeLessThan(output.indexOf("import { A }"));
    });

    it("rejects invalid generated TypeScript instead of writing unformatted output", async () => {
        const directory = await createDirectory();
        await expect(formatGeneratedFile(join(directory, "types.ts"), "export const = ;")).rejects.toThrow(
            "Could not format generated file"
        );
    });
});
