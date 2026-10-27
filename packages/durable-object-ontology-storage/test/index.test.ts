import { sqliteOntologyConformanceCases } from "@party-stack/ontology/testing/sqlite";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
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
        it(`${testCase.name}`, async () => {
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
                    "party_tables_rows"
                )
                .toArray()
        );
        expect(rows).toEqual([
            {
                name: "party_tables_rows",
            },
        ]);
    });

    it("isolates ontologies by Durable Object", async () => {
        const first = createStub();
        const second = createStub();
        await expect(first.createAndListNote("same", "first")).resolves.toEqual(["first"]);
        await expect(second.createAndListNote("same", "second")).resolves.toEqual(["second"]);
        await expect(first.createAndListNote()).resolves.toEqual(["first"]);
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

it("Alchemy uses native transactional attachment references and collects only unreferenced authoritative bytes", async () => {
    const { ALCHEMY_ONTOLOGY } = env as unknown as {
        ALCHEMY_ONTOLOGY: DurableObjectNamespace<import("./alchemy.js").AlchemyOntologyTest>;
    };
    const result = await ALCHEMY_ONTOLOGY.get(ALCHEMY_ONTOLOGY.newUniqueId()).runRetention();
    expect(result).toEqual({
        conflict: true,
        rangeText: "bytes",
        emptyText: "",
        protectedCount: 0,
        text: "shared bytes",
        stillShared: 0,
        collected: 1,
        missing: true,
        rejected: true,
        orphanCount: 1,
    });
});

for (const phase of ["write", "read"] as const) {
    it(`recovers durable blob intents and reader roots after a real DO ${phase} crash`, async () => {
        const { ALCHEMY_ONTOLOGY } = env as unknown as {
            ALCHEMY_ONTOLOGY: DurableObjectNamespace<import("./alchemy.js").AlchemyOntologyTest>;
        };
        const stub = ALCHEMY_ONTOLOGY.get(ALCHEMY_ONTOLOGY.newUniqueId());
        await expect(phase === "write" ? stub.crashAfterWrite() : stub.crashDuringRead()).rejects.toThrow(
            /Intentional crash/
        );
        // An abort permanently breaks this stub; acquire a new connection to the same DO.
        const recovered = await ALCHEMY_ONTOLOGY.get(stub.id).recoverAfterCrash();
        expect(recovered).toEqual({
            wasWriting: phase === "write",
            writing: false,
            collected: 1,
            remaining: 0,
            content: "recovered",
        });
    });
}

for (const disabled of [false, true]) {
    it(`Alchemy resource factory wires authenticated RPC, durable rows and ${disabled ? "disabled" : "scheduled"} GC without a user subclass`, async () => {
        const { ALCHEMY_ONTOLOGY } = env as unknown as {
            ALCHEMY_ONTOLOGY: DurableObjectNamespace<import("./alchemy.js").AlchemyOntologyTest>;
        };
        const result = await ALCHEMY_ONTOLOGY.get(ALCHEMY_ONTOLOGY.newUniqueId()).runResource(disabled);
        expect(result).toEqual({
            name: "ResourceNotes",
            bindingRegistered: true,
            schemaDeferred: true,
            encryptionConfigured: true,
            denied: true,
            firstAlarm: true,
            scheduled: true,
            preservedAlarm: true,
            orphanCollected: !disabled,
            content: "retained",
            title: "Resource factory",
        });
    });
}

it("R2 streams known-length bodies, cancels incomplete puts, and accepts unknown-length multipart sources", async () => {
    const { ALCHEMY_ONTOLOGY } = env as unknown as {
        ALCHEMY_ONTOLOGY: DurableObjectNamespace<import("./alchemy.js").AlchemyOntologyTest>;
    };
    await expect(ALCHEMY_ONTOLOGY.get(ALCHEMY_ONTOLOGY.newUniqueId()).runStreamingBytes()).resolves.toEqual({
        received: 10 * 1024 * 1024,
        cancelledMissing: true,
    });
});
