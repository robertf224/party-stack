import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { sqliteOntologyConformanceCases } from "@party-stack/sqlite-ontology/testing";
import { describe, expect, it } from "vitest";
import type { DurableObjectOntologyTest } from "./worker.js";

interface TestEnvironment {
    ONTOLOGY: DurableObjectNamespace<DurableObjectOntologyTest>;
}

const testEnvironment = env as unknown as TestEnvironment;

function createStub() {
    return testEnvironment.ONTOLOGY.get(testEnvironment.ONTOLOGY.newUniqueId());
}

describe("Durable Object ontology", () => {
    for (const testCase of sqliteOntologyConformanceCases) {
        it(testCase.name, async () => {
            await runInDurableObject(createStub(), async (instance) => {
                await instance.runConformance(testCase.id);
            });
        });
    }

    it("initializes SQLite under blockConcurrencyWhile", async () => {
        const rows = await runInDurableObject(createStub(), (_instance, state) =>
            state.storage.sql
                .exec(
                    `SELECT name FROM sqlite_master
                         WHERE type = 'table' AND name = ?`,
                    "party_stack_blocked_Note"
                )
                .toArray()
        );
        expect(rows).toEqual([
            {
                name: "party_stack_blocked_Note",
            },
        ]);
    });

    it("defaults authoritative attachment bytes to R2", async () => {
        await expect(createStub().runR2Backend()).resolves.toEqual({
            content: "r2-content",
            type: "text/plain",
            sqlBytesAreExternal: true,
        });
    });

    it("supports inline SQLite bytes without an R2 bucket option", async () => {
        await expect(createStub().runInlineBackendWithoutR2()).resolves.toBe(true);
    });

    it("quiesces the backend and deletes installation-scoped R2 objects", async () => {
        await expect(createStub().runR2Destruction()).resolves.toEqual({
            quiesced: true,
            r2Empty: true,
        });
    });

    it("deletes whole Durable Object SQL storage explicitly", async () => {
        const rows = await runInDurableObject(createStub(), async (instance, state) => {
            await instance.runConformance("schema");
            await instance.destroyStorage();
            return state.storage.sql
                .exec(
                    `SELECT name FROM sqlite_master
                         WHERE name LIKE 'party_stack_%'`
                )
                .toArray();
        });
        expect(rows).toEqual([]);
    });
});
