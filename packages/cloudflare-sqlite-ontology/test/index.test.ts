import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { sqliteOntologyConformanceCases } from "@party-stack/sqlite-ontology/testing";
import { describe, expect, it } from "vitest";
import type { SQLiteOntologyTestDurableObject } from "./worker.js";

interface TestEnvironment {
    SQLITE_ONTOLOGY: DurableObjectNamespace<SQLiteOntologyTestDurableObject>;
}

const testEnvironment = env as unknown as TestEnvironment;

function createStub() {
    const id = testEnvironment.SQLITE_ONTOLOGY.newUniqueId();
    return testEnvironment.SQLITE_ONTOLOGY.get(id);
}

describe("Durable Object SQLite ontology", () => {
    for (const testCase of sqliteOntologyConformanceCases) {
        it(testCase.name, async () => {
            const stub = createStub();
            await runInDurableObject(stub, async (instance) => {
                await instance.runConformance(testCase.id);
            });
        });
    }

    it("initializes schemas under blockConcurrencyWhile", async () => {
        const stub = createStub();
        const rows = await runInDurableObject(stub, (_instance, state) =>
            state.storage.sql
                .exec(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
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

    it("deletes all Durable Object storage only when explicitly destroyed", async () => {
        const stub = createStub();
        const rows = await runInDurableObject(stub, async (instance, state) => {
            await instance.runConformance("schema");
            await instance.destroyStorage();
            return state.storage.sql
                .exec("SELECT name FROM sqlite_master WHERE name LIKE 'party_stack_%'")
                .toArray();
        });

        expect(rows).toEqual([]);
    });
});
