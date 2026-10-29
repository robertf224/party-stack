import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { asProvider } from "@party-stack/runtime/testing";
import { defineRuntimeFixture, runtimeFixtureContext } from "@party-stack/runtime/testing";
import { queryOnce } from "@tanstack/db";
import { Effect, Exit, Scope } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { createLiveOntology } from "../live/LiveOntology.js";
import { makeReplicaHost } from "./host.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "rename",
            displayName: "Rename",
            parameters: [
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "note" },
                    values: [{ property: ["title"], value: o.Expression.inputReference({ name: "title" }) }],
                }),
            ],
        },
    ],
};

test("LiveOntology persists and restores offline projections, exposes local-only inspection, and records Effect spans", async () => {
    const local = await Effect.runPromise(Memory.make());
    const server = await Effect.runPromise(Memory.make());
    const backend = await Effect.runPromise(
        makeOwnedBackend({
            namespace: "server",
            ir,
            tables: server,
            mutators: {
                rename: (tx, invocation) =>
                    tx.put("Note", { id: invocation.parameters.note, title: invocation.parameters.title }),
            },
        })
    );
    await Effect.runPromise(
        backend.storage.transaction((tx) => tx.put("Note", { id: "one", title: "Before" }))
    );
    let online = true;
    const listeners = new Set<(value: boolean) => void>();
    const requests = vi.fn();
    const adapter = (): import("../live/OntologyBackendAdapter.js").OntologyBackendAdapter => ({
        name: "test",
        open: () =>
            Effect.succeed({
                ...backend,
                loadSubset: (subset) =>
                    Effect.suspend(() => {
                        requests();
                        if (!online) throw new Error("Network load during offline replay");
                        return backend.loadSubset(subset);
                    }),
                applyAction: (action) =>
                    Effect.suspend(() => {
                        requests();
                        if (!online) throw new Error("Offline dispatch");
                        return backend.applyAction(action);
                    }),
                changes: {
                    pull: (query) =>
                        Effect.suspend(() => {
                            requests();
                            if (!online) throw new Error("Offline pull");
                            return backend.changes!.pull(query);
                        }),
                },
            }),
    });
    const runtime = defineRuntimeFixture((owner, namespace) => {
        return {
            owner,
            namespace,

            tables: Effect.succeed(local),
            blobBytes: new MemoryBlobBytesStore(),
            connectivity: {
                get isConnected() {
                    return online;
                },
                subscribe: (cb: (value: boolean) => void) => {
                    listeners.add(cb);
                    return () => {
                        listeners.delete(cb);
                    };
                },
            },
        };
    });
    const settings = {
        ir,
        backend: adapter,
        runtime: asProvider(runtime),
        persistObjects: true,
        writes: { defaultMode: "outbox" as const, defaultVisibility: "optimistic" as const },
    };
    const first = await createLiveOntology(settings);
    try {
        await queryOnce((q) => q.from({ note: first.objects.Note! }));
        await vi.waitFor(async () =>
            expect((await Effect.runPromise(first.storage!.get("Note", "one")))?.title).toBe("Before")
        );
        online = false;
        for (const cb of listeners) cb(false);
        const before = requests.mock.calls.length;
        const action = first.actions.rename!({ note: "one", title: "Offline" });
        void action.catch(() => undefined);
        await vi.waitFor(async () =>
            expect((await Effect.runPromise(first.storage!.get("Note", "one")))?.title).toBe("Offline")
        );
        expect(requests.mock.calls.length).toBe(before);
        expect(first.persistedObjects).toBeDefined();
        await first.cleanup();
        const reopened = await createLiveOntology(settings);
        try {
            expect((await Effect.runPromise(reopened.storage!.get("Note", "one")))?.title).toBe("Offline");
            expect(requests.mock.calls.length).toBe(before);
            expect(reopened.traces?.getSnapshot().some((trace) => trace.name === "Replica.rebase")).toBe(
                true
            );
            online = true;
            for (const cb of listeners) cb(true);
            await vi.waitFor(async () =>
                expect(await Effect.runPromise(reopened.storage!.pending)).toEqual([])
            );
            expect(
                (await Effect.runPromise(backend.loadSubset({ objectType: "Note" }))).rows[0]?.value.title
            ).toBe("Offline");
        } finally {
            await reopened.cleanup();
        }
    } finally {
        await first.cleanup();
    }
});

test("runtime cleanup closes the ontology's DbClient collections and sync scope", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const backend = await Effect.runPromise(
        makeOwnedBackend({ namespace: "lifetime-server", ir, tables, mutators: {} })
    );
    const runtime = defineRuntimeFixture(() => ({
        owner: "user",
        namespace: "lifetime",
        tables: Effect.succeed(tables),

        blobBytes: new MemoryBlobBytesStore(),
        connectivity: { isConnected: false, subscribe: () => () => undefined },
    }))("user", "lifetime");
    const cleanupBackend = vi.fn();
    const ontology = await createLiveOntology({
        ir,
        runtime: asProvider(() => runtime),
        backend: () => ({
            name: "lifetime",
            open: () => Effect.acquireRelease(Effect.succeed(backend), () => Effect.sync(cleanupBackend)),
        }),
        persistObjects: true,
    });
    await runtime.cleanup?.();
    expect(Object.values(ontology.objects).every((collection) => collection.status === "cleaned-up")).toBe(
        true
    );
    expect(
        Object.values(ontology.persistedObjects!).every((collection) => collection.status === "cleaned-up")
    ).toBe(true);
    expect(ontology.outbox.collection.status).toBe("cleaned-up");
    await expect(Effect.runPromise(ontology.storage!.pending)).rejects.toMatchObject({
        kind: "InvalidRequest",
    });
    expect(cleanupBackend).toHaveBeenCalledOnce();
    await ontology.cleanup();
});

test("a scoped replica host runs without application collections and outlives individual reader sessions", async () => {
    const local = await Effect.runPromise(Memory.make());
    const server = await Effect.runPromise(Memory.make());
    const backend = await Effect.runPromise(
        makeOwnedBackend({ namespace: "host-server", ir, tables: server, mutators: {} })
    );
    const released = vi.fn();
    const adapter: import("../live/OntologyBackendAdapter.js").OntologyBackendAdapter = {
        name: "host",
        open: () =>
            Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.sync(released));
                return {
                    ...backend,
                    attachments: {
                        read: (value) => Effect.promise(() => readAttachment(value)),
                        metadata: () => Effect.succeed({ size: 12, type: "" }),
                    },
                };
            }),
    };
    const readAttachment = vi.fn((_value: import("@party-stack/ontology-spec/values").attachment) =>
        Promise.resolve(new Blob(["remote bytes"]))
    );
    const runtime = defineRuntimeFixture(() => ({
        owner: "user",
        namespace: "scoped-host",
        tables: Effect.succeed(local),

        blobBytes: new MemoryBlobBytesStore(),
        connectivity: { isConnected: false, subscribe: () => () => undefined },
    }))("user", "scoped-host");
    const managed = runtimeFixtureContext(runtime).runtime;
    const owner = Effect.runSync(Scope.make());
    const firstSession = Effect.runSync(Scope.make());
    const secondSession = Effect.runSync(Scope.make());
    try {
        const host = await managed.runPromise(
            Scope.provide(makeReplicaHost({ ir, context: {}, runtime, backendAdapter: adapter }), owner)
        );
        await Effect.runPromise(Scope.provide(host.replica.retainLocal("Note"), firstSession));
        await Effect.runPromise(Scope.provide(host.replica.retainLocal("Note"), secondSession));
        await Effect.runPromise(Scope.close(firstSession, Exit.void));
        expect(await Effect.runPromise(host.replica.pending)).toEqual([]);
        expect(released).not.toHaveBeenCalled();
        await Effect.runPromise(host.blobManager.stage("local-attachment", new Blob(["local bytes"])));
        await Effect.runPromise(host.blobManager.bindRemoteId("local-attachment", "remote-attachment"));
        const blobs = host.blobManager.storage;
        await Effect.runPromise(blobs.collectGarbage({ olderThanMs: 0 }));
        const source = { objectType: "Note", primaryKey: "one", property: "file" };
        expect(
            await (
                await Effect.runPromise(
                    host.blobManager.read("local-attachment", {
                        meta: { attachment: { id: "local-attachment", source } },
                    })
                )
            ).text()
        ).toBe("remote bytes");
        expect(readAttachment).toHaveBeenCalledWith({ id: "remote-attachment", source });
        await Effect.runPromise(Scope.close(secondSession, Exit.void));
        expect(await Effect.runPromise(host.replica.pending)).toEqual([]);
        await Effect.runPromise(Scope.close(owner, Exit.void));
        expect(released).toHaveBeenCalledOnce();
        await expect(Effect.runPromise(host.blobManager.read("local"))).rejects.toThrow("closed");
        await expect(Effect.runPromise(host.replica.pending)).rejects.toMatchObject({
            kind: "InvalidRequest",
        });
    } finally {
        await Effect.runPromise(Scope.close(firstSession, Exit.void));
        await Effect.runPromise(Scope.close(secondSession, Exit.void));
        await Effect.runPromise(Scope.close(owner, Exit.void));
        await runtime.cleanup?.();
    }
});
