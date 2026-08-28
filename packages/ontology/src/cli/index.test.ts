import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

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
