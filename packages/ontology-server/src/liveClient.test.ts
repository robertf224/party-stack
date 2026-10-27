import { o, type OntologyIR } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore, Runtime } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import { createConnectedLiveOntology } from "./liveClient.js";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import type { OntologyConnection } from "./rpc.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};

test("framework composition retains platform/transport after acquisition, confirms actions, and closes both", async () => {
    const released: string[] = [];
    let parent: OntologyConnection | undefined;
    const runtime = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    released.push("runtime");
                })
            );
            return yield* Runtime.make({
                owner: "test",
                namespace: "client",
                blobBytes: new MemoryBlobBytesStore(),
            });
        })
    );
    const connection = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                released.push("transport");
            })
        );
        const backend = yield* makeOwnedBackend({
            ir,
            namespace: "client-parent",
            tables: yield* Memory.make(),
            mutators: {
                increment: (tx) =>
                    Effect.gen(function* () {
                        const row = yield* tx.get("Counter", "one");
                        yield* tx.put("Counter", { id: "one", count: Number(row?.count ?? 0) + 1 });
                    }),
            },
        });
        yield* backend.applyAction({ id: "seed", name: "increment", parameters: {} });
        const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
            Effect.provide(ontologyRpcHandlers({ source: backend.protocol, authorize: () => Effect.void }))
        );
        parent = yield* makeOntologyProtocolClient(client);
        return parent;
    });
    const live = await createConnectedLiveOntology({
        ir,
        runtime,
        connection,
        label: "Client",
        parent: { label: "Authority" },
        writes: { defaultMode: "outbox", defaultVisibility: "optimistic" },
    });
    try {
        expect(released).toEqual([]);
        expect(live.attachments).toBe(parent!.operations.attachments);
        const rows = await queryOnce((q) => q.from({ counter: live.objects.Counter! }));
        expect(rows[0]?.count).toBe(1);
        await live.actions.increment!({});
        expect((await queryOnce((q) => q.from({ counter: live.objects.Counter! })))[0]?.count).toBe(2);
        expect(live.diagnostics?.parent?.label).toBe("Authority");
        expect(live.traces?.getSnapshot().length).toBeGreaterThan(0);
    } finally {
        await live.cleanup();
    }
    await live.cleanup();
    expect(released).toEqual(["transport", "runtime"]);
    expect(live.objects.Counter!.status).toBe("cleaned-up");
});

test("startup failure closes the partial transport and platform and preserves the typed error", async () => {
    const released: string[] = [];
    const failure = new BackendError({
        operation: "worker.connect",
        kind: "Unauthenticated",
        message: "Sign in again.",
        retryable: false,
    });
    const runtime = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    released.push("runtime");
                })
            );
            return yield* Runtime.make({
                owner: "test",
                namespace: "failure",
                blobBytes: new MemoryBlobBytesStore(),
            });
        })
    );
    const connection = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                released.push("transport");
            })
        );
        return yield* failure;
    });
    await expect(createConnectedLiveOntology({ ir, runtime, connection })).rejects.toBe(failure);
    expect(released).toEqual(["transport", "runtime"]);
});
