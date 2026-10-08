import { MemoryBlobBytesStore, SingleProcessCoordination } from "@party-stack/runtime";
import { createLiveQueryCollection } from "@tanstack/db";
import { describe, expect, it, vi } from "vitest";
import type { BlobManager } from "@party-stack/blobs";
import { o } from "../../ir/index.js";
import { createLiveOntologyActions } from "../actions/createLiveOntologyActions.js";
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
    const collections = new Map<string, Map<string, Record<string, unknown>>>();
    const rowsFor = (collectionId: string) => {
        let rows = collections.get(collectionId);
        if (!rows) {
            rows = new Map(collectionId.endsWith(":objects:Task") ? initial.map(({ key, value }) => [key, value]) : []);
            collections.set(collectionId, rows);
        }
        return rows;
    };
    const positions = new Map<
        string,
        {
            latestTerm: number;
            latestSeq: number;
            latestRowVersion: number;
        }
    >();
    const applyCommittedTx = vi.fn((collectionId: string, transaction: PersistedTx) => {
        const rows = rowsFor(collectionId);
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
            loadResumeSnapshot: (collectionId) =>
                Promise.resolve({
                    rows: [...rowsFor(collectionId)].map(([key, value]) => ({ key, value })),
                    collectionMetadata: [],
                    ...(positions.get(collectionId) ?? { latestTerm: 0, latestSeq: 0, latestRowVersion: 0 }),
                    resetEpoch: 0,
                }),
            loadSubset: (collectionId) =>
                Promise.resolve(
                    [...rowsFor(collectionId)].map(([key, value]) => ({
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
        const resolvePersistenceForCollection = vi.fn(() => persistence);
        const collection = createLiveOntologyObjectCollection({
            ...options,
            backendAdapter: backend(({ markReady }) => markReady()),
            runtime: {
                owner: options.owner,
                namespace: options.ontologyId,
                blobBytes: new MemoryBlobBytesStore(),
                coordination: options.coordination,
                persistence: { ...persistence, resolvePersistenceForCollection },
            },
            persistObjects: true,
        });

        await collection.preload();

        expect(collection.id).toBe("party-stack:user-1:ontology-1:objects:Task");
        expect(resolvePersistenceForCollection).toHaveBeenCalledWith({
            collectionId: collection.id,
            mode: "sync-present",
            schemaVersion: 1,
        });
        expect(collection.get("persisted")).toMatchObject({
            title: "From persistence",
        });
        await collection.cleanup();
        await options.coordination.close();
    });

    it("publishes persisted ordered rows while a remote subset is still loading", async () => {
        const options = createOptions();
        const persistence = memoryPersistence([{ key: "persisted", value: { id: "persisted", title: "Cached task" } }]);
        let finishRemote!: () => void;
        const remote = new Promise<void>((resolve) => { finishRemote = resolve; });
        const loadSubset = vi.fn(() => remote);
        const collection = createLiveOntologyObjectCollection({
            ...options,
            backendAdapter: {
                ...backend(({ markReady }) => markReady()),
                getCollectionOptions: () => ({
                    syncMode: "on-demand",
                    sync: { sync: ({ markReady }) => { markReady(); return { loadSubset }; } },
                }),
            },
            runtime: {
                owner: options.owner, namespace: options.ontologyId,
                blobBytes: new MemoryBlobBytesStore(), coordination: options.coordination, persistence,
            },
            persistObjects: true,
        });
        const query = createLiveQueryCollection({
            query: (q) => q.from({ task: collection }).orderBy(({ task }) => task.title, "asc"),
            startSync: true,
        });
        try {
            await vi.waitFor(() => expect(loadSubset).toHaveBeenCalled());
            await vi.waitFor(() => expect(query.toArray).toMatchObject([{ id: "persisted", title: "Cached task" }]));
            expect(query.status).not.toBe("ready");
            finishRemote();
            await vi.waitFor(() => expect(query.status).toBe("ready"));
        } finally {
            finishRemote();
            await query.cleanup();
            await collection.cleanup();
            await options.coordination.close();
        }
    });

    // Known gap: optimistic object lookups use queryOnce, whose readiness includes
    // remote subset refresh. Keep this witness until persistence-only reads land.
    it.fails("projects and restores queued edits from cached objects without waiting for the remote subset", async () => {
        const options = createOptions();
        const persistence = memoryPersistence([{ key: "persisted", value: { id: "persisted", title: "Before" } }]);
        let finishRemote!: () => void;
        const remote = new Promise<void>((resolve) => { finishRemote = resolve; });
        const loadSubset = vi.fn(() => remote);
        const applyAction = vi.fn(() => Promise.resolve());
        const backendAdapter: OntologyBackendAdapter = {
            ...backend(({ markReady }) => markReady()), applyAction,
            getCollectionOptions: () => ({ syncMode: "on-demand", sync: { sync: ({ markReady }) => {
                markReady(); return { loadSubset };
            } } }),
        };
        const runtime = {
            owner: options.owner, namespace: options.ontologyId,
            blobBytes: new MemoryBlobBytesStore(), coordination: options.coordination, persistence,
            connectivity: { isConnected: false, subscribe: () => () => undefined },
        };
        const actionIr: OntologyIR = { ...ir, actionTypes: [{
            name: "edit", displayName: "Edit", parameters: [
                { name: "task", displayName: "Task", type: o.objectReference({ objectType: "Task" }) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ], logic: [o.ActionLogicStep.updateObject({ object: { name: "task" }, values: [
                { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
                { property: ["previousTitle"], value: o.Expression.getAt({
                    source: o.Expression.objectLookup({ reference: o.Expression.inputReference({ name: "task" }) }),
                    path: ["title"],
                }) },
            ] })],
        }] };
        const collection = createLiveOntologyObjectCollection({ ...options, runtime, backendAdapter, persistObjects: true });
        const query = createLiveQueryCollection({ query: (q) => q.from({ task: collection }), startSync: true });
        const actionCoordination = new SingleProcessCoordination({ scope: "offline-projection-outbox" });
        const createActions = () => createLiveOntologyActions({
            ir: actionIr, runtime: { ...runtime, coordination: actionCoordination }, backendAdapter, objects: { Task: collection }, context: {},
            blobManager: {} as BlobManager,
            writes: { defaultMode: "outbox", defaultVisibility: "optimistic" },
        });
        let actions: ReturnType<typeof createActions> | undefined;
        try {
            await vi.waitFor(() => expect(query.toArray).toMatchObject([{ title: "Before" }]));
            actions = createActions();
            await actions.outbox.ready;
            let submissionError: unknown;
            void actions.actions.edit!({ task: "persisted", title: "After" }).catch((error: unknown) => { submissionError = error; });
            await vi.waitFor(() => { expect(submissionError).toBeUndefined(); expect(actions!.outbox.collection.size).toBe(1); });
            await vi.waitFor(() => expect(collection.get("persisted")).toMatchObject({ title: "After", previousTitle: "Before" }));
            expect(applyAction).not.toHaveBeenCalled();
            await actions.outbox.cleanup();
            await vi.waitFor(() => expect(collection.get("persisted")?.title).toBe("Before"));
            actions = createActions();
            await actions.outbox.ready;
            expect(collection.get("persisted")).toMatchObject({ title: "After", previousTitle: "Before" });
            expect(applyAction).not.toHaveBeenCalled();
        } finally {
            finishRemote();
            await actions?.outbox.cleanup();
            await actionCoordination.close();
            await query.cleanup();
            await collection.cleanup();
            await options.coordination.close();
        }
    });

    it("persists authoritative backend sync transactions", async () => {
        const options = createOptions();
        const persistence = memoryPersistence();
        const collection = createLiveOntologyObjectCollection({
            ...options,
            backendAdapter: backend(({ begin, write, commit, markError, markReady }) => {
                begin();
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
                persistence,
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
