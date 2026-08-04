import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { createStaticMetaOntologyBackendAdapter } from "../meta/createStaticMetaOntologyBackend.js";
import { writePulledOntology } from "./pull.js";
import type { OntologyIR } from "../ir/index.js";
import type { OntologyConfig } from "../OntologyConfig.js";

const fixtureIr: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Task",
            id: "ri.ontology.main.object-type.task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            titleProperty: "title",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createTask",
            id: "ri.actions.main.action-type.create-task",
            displayName: "Create Task",
            parameters: [{ name: "title", displayName: "Title", type: o.string({}) }],
            logic: [],
        },
    ],
    queryFunctionTypes: [],
};

describe("writePulledOntology", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("writes a generated ontology module and cleans up the meta ontology", async () => {
        const dir = mkdtempSync(join(tmpdir(), "party-stack-pull-"));
        tempDirs.push(dir);
        const outPath = join(dir, "ontology.ts");

        const config: OntologyConfig = {
            adapter: {
                createAdapter: () => createStaticMetaOntologyBackendAdapter({ ir: fixtureIr }),
            },
            opts: {},
            objectTypeNames: ["Task"],
            actionTypeNames: ["createTask"],
            queryFunctionTypeNames: [],
        };

        await writePulledOntology(config, outPath, "@party-stack/ontology");

        const contents = readFileSync(outPath, "utf-8");
        expect(contents).toContain("Auto-generated file");
        expect(contents).toContain("Task");
        expect(contents).toContain("createTask");
        expect(contents).toContain("titleProperty");
    });

    it("cleans up even when generation fails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "party-stack-pull-fail-"));
        tempDirs.push(dir);
        const outPath = join(dir, "readonly", "ontology.ts");
        writeFileSync(join(dir, "readonly"), "not-a-directory");

        let cleanedUp = false;
        const config: OntologyConfig = {
            adapter: {
                createAdapter: () => {
                    const adapter = createStaticMetaOntologyBackendAdapter({ ir: fixtureIr });
                    return {
                        ...adapter,
                        cleanup: () => {
                            cleanedUp = true;
                        },
                    };
                },
            },
            opts: {},
            objectTypeNames: ["Task"],
            actionTypeNames: [],
        };

        await expect(writePulledOntology(config, outPath)).rejects.toThrow();
        expect(cleanedUp).toBe(true);
    });
});
