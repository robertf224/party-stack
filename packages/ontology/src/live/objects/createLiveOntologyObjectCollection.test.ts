import { MemoryBlobBytesStore, SingleProcessCoordination } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { o } from "../../ir/index.js";
import { createLiveOntologyObjectCollection } from "./createLiveOntologyObjectCollection.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyBackendAdapter } from "../OntologyBackendAdapter.js";
import type { PersistedTx, PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

function backend(
    sync: ReturnType<OntologyBackendAdapter["getCollectionOptions"]>["sync"]["sync"]
): OntologyBackendAdapter {
    return {
        name: "test",
        getCollectionOptions: () => ({
            syncMode: "eager",
            sync: { sync },
        }),
        applyAction: () => Promise.resolve(),
        runQueryFunction: () => Promise.resolve(undefined),
    };
}

function memoryPersistence(
    initial: Array<{
        key: string;
        value: Record<string, unknown>;
    }> = []
): {
    adapter: PersistenceAdapter;
    applyCommittedTx: ReturnType<typeof vi.fn>;
} {
    const rows = new Map(initial.map(({ key, value }) => [key, value]));
    const positions = new Map<
        string,
        {
            latestTerm: number;
            latestSeq: number;
            latestRowVersion: number;
        }
    >();
    const applyCommittedTx = vi.fn((collectionId: string, transaction: PersistedTx) => {
        if (transaction.truncate) rows.clear();
        for (const mutation of transaction.mutations) {
            if (mutation.type === "delete") {
                rows.delete(String(mutation.key));
            } else {
                rows.set(String(mutation.key), mutation.value);
            }
        }
        positions.set(collectionId, {
            latestTerm: transaction.term,
            latestSeq: transaction.seq,
            latestRowVersion: transaction.rowVersion,
        });
        return Promise.resolve();
    });
    return {
        adapter: {
            loadSubset: () =>
                Promise.resolve(
                    [...rows].map(([key, value]) => ({
                        key,
                        value,
                    }))
                ),
            applyCommittedTx,
            ensureIndex: () => Promise.resolve(),
            getStreamPosition: (collectionId) =>
                Promise.resolve(
                    positions.get(collectionId) ?? {
                        latestTerm: 0,
                        latestSeq: 0,
                        latestRowVersion: 0,
                    }
                ),
        },
        applyCommittedTx,
    };
}

function createOptions() {
    const coordination = new SingleProcessCoordination({
        scope: "object-persistence-test",
    });
    return {
        owner: "user-1",
        ontologyId: "ontology-1",
        ir,
        objectType: ir.objectTypes[0]!,
        coordination,
    };
}

describe("createLiveOntologyObjectCollection", () => {
    it("fails fast when object persistence has no adapter", async () => {
        const options = createOptions();

        expect(() =>
            createLiveOntologyObjectCollection({
                ...options,
                backendAdapter: backend(({ markReady }) => markReady()),
                runtime: {
                    owner: options.owner,
                    namespace: options.ontologyId,
                    blobBytes: new MemoryBlobBytesStore(),
                    coordination: options.coordination,
                },
                persistObjects: true,
            })
        ).toThrow("Live ontology object persistence requires a runtime persistence adapter");
        await options.coordination.close();
    });

    it("hydrates persisted objects before marking the collection ready", async () => {
        const options = createOptions();
        const persistence = memoryPersistence([
            {
                key: "persisted",
                value: {
                    id: "persisted",
                    title: "From persistence",
                },
            },
        ]);
        const collection = createLiveOntologyObjectCollection({
            ...options,
            backendAdapter: backend(({ markReady }) => markReady()),
            runtime: {
                owner: options.owner,
                namespace: options.ontologyId,
                blobBytes: new MemoryBlobBytesStore(),
                coordination: options.coordination,
                persistence: persistence.adapter,
            },
            persistObjects: true,
        });

        await collection.preload();

        expect(collection.id).toBe("party-stack:user-1:ontology-1:objects:Task");
        expect(collection.get("persisted")).toMatchObject({
            title: "From persistence",
        });
        await collection.cleanup();
        await options.coordination.close();
    });

    it("persists authoritative backend sync transactions", async () => {
        const options = createOptions();
        const persistence = memoryPersistence();
        const collection = createLiveOntologyObjectCollection({
            ...options,
            backendAdapter: backend(({ begin, write, commit, markError, markReady }) => {
                begin({ immediate: true });
                write({
                    type: "insert",
                    value: {
                        id: "remote",
                        title: "From backend",
                    },
                });
                const receipt = commit();
                if (receipt === true) {
                    markReady();
                } else {
                    void receipt.then(markReady, markError);
                }
            }),
            runtime: {
                owner: options.owner,
                namespace: options.ontologyId,
                blobBytes: new MemoryBlobBytesStore(),
                coordination: options.coordination,
                persistence: persistence.adapter,
            },
            persistObjects: true,
        });

        await collection.preload();
        await vi.waitFor(() => {
            expect(persistence.applyCommittedTx).toHaveBeenCalled();
        });
        expect(collection.get("remote")).toMatchObject({
            title: "From backend",
        });
        await collection.cleanup();
        await options.coordination.close();
    });
});
