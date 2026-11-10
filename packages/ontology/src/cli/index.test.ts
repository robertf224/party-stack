import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) =>
            rm(directory, {
                recursive: true,
                force: true,
            })
        )
    );
});

describe("ontology CLI", () => {
    it("generates identical files without evaluating consumer Vite config", async () => {
        const cwd = await mkdtemp(resolve(tmpdir(), "ontology-generate-"));
        directories.push(cwd);
        const cliPath = fileURLToPath(new URL("../../lib/cli/index.js", import.meta.url));
        const schemaPath = fileURLToPath(new URL("../../../ontology-spec/src/ir/schema.ts", import.meta.url));
        const generate = () =>
            execFileAsync(
                process.execPath,
                [cliPath, "generate", "--ontology", schemaPath, "--outDir", "generated"],
                { cwd }
            );
        await generate();
        const names = ["types.ts", "builders.ts", "constants.ts"];
        const before = await Promise.all(
            names.map((name) => readFile(resolve(cwd, "generated", name), "utf8"))
        );
        await writeFile(resolve(cwd, "vite.config.ts"), "throw new Error('Vite config evaluated');");
        await writeFile(resolve(cwd, ".oxfmtrc.json"), JSON.stringify({ tabWidth: 2, singleQuote: true }));
        await generate();
        const after = await Promise.all(
            names.map((name) => readFile(resolve(cwd, "generated", name), "utf8"))
        );
        expect(after).toEqual(before);
        for (const output of after) {
            expect(output).toMatch(/^\/\/ Auto-generated file - do not edit manually\n\n/);
        }
    }, 20_000);

    it("does not evaluate pull configuration for help commands", async () => {
        const cwd = await mkdtemp(resolve(tmpdir(), "ontology-cli-"));
        directories.push(cwd);
        const configPath = resolve(cwd, "src/ontology/config.ts");
        await mkdir(dirname(configPath), {
            recursive: true,
        });
        await writeFile(configPath, `throw new Error("pull config evaluated");`);
        const cliPath = fileURLToPath(new URL("../../lib/cli/index.js", import.meta.url));

        const rootHelp = await execFileAsync(process.execPath, [cliPath, "--help"], { cwd });
        expect(rootHelp.stdout).toContain("Generate and pull ontology files");
        const generateHelp = await execFileAsync(process.execPath, [cliPath, "generate", "--help"], { cwd });
        expect(generateHelp.stdout).toContain("Generate ontology types");
        const pullHelp = await execFileAsync(process.execPath, [cliPath, "pull", "--help"], { cwd });
        expect(pullHelp.stdout).toContain("Pull ontology metadata");
    }, 20_000);
});
