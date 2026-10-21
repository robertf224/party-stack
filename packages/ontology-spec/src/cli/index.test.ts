import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const cli = fileURLToPath(new URL("../../lib/cli/index.js", import.meta.url));

describe("standalone spec codegen", () => {
    it("bootstraps the self-hosted IR deterministically without live ontology", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "ontology-spec-bootstrap-"));
        directories.push(cwd);
        const schema = fileURLToPath(new URL("../ir/schema.ts", import.meta.url));
        const run = () =>
            execute(process.execPath, [cli, "generate", "--ontology", schema, "--outDir", "generated"], {
                cwd,
            });
        await run();
        const names = ["types.ts", "builders.ts", "constants.ts"];
        const before = await Promise.all(names.map((name) => readFile(join(cwd, "generated", name), "utf8")));
        await writeFile(join(cwd, "vite.config.ts"), "throw new Error('must not load app configuration');");
        await run();
        expect(
            await Promise.all(names.map((name) => readFile(join(cwd, "generated", name), "utf8")))
        ).toEqual(before);
        expect(before[0]).toContain("@party-stack/ontology-spec/values");
        expect(before[0]).not.toContain('"@party-stack/ontology/');
    }, 20000);
    it("generates ontology models with attachments, references, and Temporal without live factories", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "ontology-spec-model-"));
        directories.push(cwd);
        const string = { kind: "string", value: {} };
        const property = (name: string, type: object) => ({ name, displayName: name, type });
        const schema = {
            types: [],
            objectTypes: [
                {
                    name: "User",
                    displayName: "User",
                    pluralDisplayName: "Users",
                    primaryKey: "id",
                    properties: [
                        property("id", string),
                        property("avatar", { kind: "attachment", value: {} }),
                        property("manager", { kind: "objectReference", value: { objectType: "User" } }),
                        property("birthday", { kind: "date", value: {} }),
                        property("createdAt", { kind: "timestamp", value: {} }),
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        };
        await writeFile(join(cwd, "ontology.ts"), `export default ${JSON.stringify(schema)};`);
        await execute(
            process.execPath,
            [
                cli,
                "generate",
                "--ontology",
                "ontology.ts",
                "--outDir",
                "generated",
                "--namespace",
                "Example",
                "--no-live",
            ],
            { cwd }
        );
        expect((await readdir(join(cwd, "generated"))).sort()).toEqual(["constants.ts", "types.ts"]);
        const types = await readFile(join(cwd, "generated/types.ts"), "utf8");
        expect(types).toContain("avatar: v.attachment");
        expect(types).toContain("manager: string");
        expect(types).toContain("birthday: v.date");
        expect(types).toContain("createdAt: v.timestamp");
        expect(types).not.toContain('"@party-stack/ontology"');
        await execute(
            process.execPath,
            [
                cli,
                "generate",
                "--ontology",
                "ontology.ts",
                "--outDir",
                "generated",
                "--namespace",
                "Example",
                "--no-live",
                "--effect",
                "--no-js-extensions",
            ],
            { cwd }
        );
        expect((await readdir(join(cwd, "generated"))).sort()).toEqual([
            "constants.ts",
            "effect-types.ts",
            "effect.ts",
            "types.ts",
        ]);
        const schemas = await readFile(join(cwd, "generated/effect.ts"), "utf8");
        expect(schemas).toContain('from "./effect-types"');
        expect(schemas).toContain('from "./types"');
        expect(schemas).toContain("UserSchema");
        expect(await readFile(join(cwd, "generated/effect-types.ts"), "utf8")).toContain(
            "@party-stack/ontology-spec/effect/values"
        );
    }, 20000);
});
