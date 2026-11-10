import { o, type OntologyIR } from "@party-stack/ontology";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import {
    makeOntologyProtocolClient,
    ontologyRpcHandlers,
    OntologyRpcs,
} from "@party-stack/ontology-server/rpc";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore, Runtime, RuntimePartition, Runtimes } from "@party-stack/runtime";
import { makeTestRuntime } from "@party-stack/runtime/testing";
import { queryOnce } from "@tanstack/db";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, test, expectTypeOf } from "vite-plus/test";
import { createLiveOntology } from "../live/LiveOntology.js";
import type { OntologyClient, OntologyDescription } from "@party-stack/ontology-server/rpc";

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
    let parent: OntologyClient | undefined;
    const requests: string[] = [];
    const runtime = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    released.push("runtime");
                })
            );
            return yield* makeTestRuntime({
                owner: "test",
                namespace: "client",
                blobBytes: new MemoryBlobBytesStore(),
            });
        })
    );
    const client = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                released.push("transport");
            })
        );
        const definition = {
            ...ir,
            context: {
                type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }),
            },
        };
        const backend = yield* makeOwnedBackend({
            ir: definition,
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
            Effect.provide(
                ontologyRpcHandlers({
                    enableRealtime: true,
                    backend,
                    ir: definition,
                    context: { user: "alice" },
                    authorize: (request) =>
                        Effect.sync(() => {
                            requests.push(request.operation);
                        }),
                })
            )
        );
        parent = yield* makeOntologyProtocolClient(client);
        return parent;
    });
    const live = await createLiveOntology<{
        context: { user: string };
        objectTypes: { Counter: { id: string; count: number } };
        actionTypes: { increment: { parameters: Record<string, never> } };
        queryFunctionTypes: {};
    }>({
        runtime: Runtimes.layer(runtime),
        client,
        label: "Client",
        traceRecording: "buffer",
        parent: { label: "Authority" },
        writes: { defaultVisibility: "optimistic" },
        demand: { idleRetentionMs: 30_000 },
        cache: { objects: { maxBytes: 64 * 1024 * 1024 } },
    });
    try {
        expect(released).toEqual([]);
        expect(live.context).toEqual({ user: "alice" });
        expect(live.attachments).not.toBe(parent!.operations.attachments);
        expect(parent!.replication.kind).toBe("committed");
        const rows = await queryOnce((q) => q.from({ counter: live.objects.Counter! }));
        expectTypeOf(rows[0]!.count).toEqualTypeOf<number>();
        expect(rows[0]?.count).toBe(1);
        await live.actions.increment!({});
        expect((await queryOnce((q) => q.from({ counter: live.objects.Counter! })))[0]?.count).toBe(2);
        expect(live.diagnostics?.parent?.label).toBe("Authority");
        expect(live.diagnostics?.parent?.replica).toBe(parent!.operations.replicaMonitor);
        expect(live.diagnostics?.parent?.traces).toBe(parent!.operations.traces);
        expect(requests).toEqual(
            expect.arrayContaining(["SubscribeSelection", "AckDelivery", "ApplyAction"])
        );
        expect(
            requests.some((operation) =>
                ["OpenClient", "Read", "Submit", "Acknowledge", "Demand"].includes(operation)
            )
        ).toBe(false);
        expect(live.traces?.getSnapshot().length).toBeGreaterThan(0);
    } finally {
        await live.cleanup();
    }
    await live.cleanup();
    expect(released).toEqual(["transport", "runtime"]);
    expect(live.objects.Counter!.status).toBe("cleaned-up");
});

test("automatic client namespaces separate sources under the declared context owner", async () => {
    const context = { user: "alice", tenant: "first" };
    const definition: OntologyIR = {
        ...ir,
        context: {
            type: o.struct({
                fields: [
                    { name: "user", displayName: "User", type: o.string({}) },
                    { name: "tenant", displayName: "Tenant", type: o.string({}) },
                ],
            }),
            partition: [["tenant"], ["user"]],
        },
    };
    const partitions: { owner: string; namespace: string }[] = [];
    const runtime = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const partition = yield* RuntimePartition;
            partitions.push(partition);
            return yield* makeTestRuntime({ ...partition, blobBytes: new MemoryBlobBytesStore() });
        })
    );
    const open = (sourceId: string, id?: string) => {
        const description: OntologyDescription = {
            version: 1,
            replication: "committed",
            sourceId,
            ir: definition,
            context,
            supportsIdempotency: false,
        };
        return createLiveOntology({
            runtime: Runtimes.layer(runtime),
            id,
            client: Effect.succeed({
                description,
                definition: {
                    get: Effect.succeed({ status: "current" as const, refreshing: false }),
                    changes: Stream.empty,
                    refresh: Effect.succeed(description),
                },
                sourceId,
                ir: definition,
                context,
                replication: { kind: "committed" as const },
                operations: {} as OntologyClient["operations"],
                backend: makeOntologyBackend({
                    ir: definition,
                    name: sourceId,
                    sourceId,
                    supportsIdempotency: false,
                    loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                    queryFunction: () => Effect.void,
                    applyAction: () => Effect.die("No action is applied in this test."),
                }),
            }),
        });
    };
    const first = await open("one");
    const second = await open("two");
    const override = await open("one", "explicit-cache");
    try {
        const owner = contextPartition(definition, context);
        expect(partitions).toEqual([
            { owner, namespace: JSON.stringify(["source", "one"]) },
            { owner, namespace: JSON.stringify(["source", "two"]) },
            { owner, namespace: "explicit-cache" },
        ]);
    } finally {
        await Promise.all([first.cleanup(), second.cleanup(), override.cleanup()]);
    }
});

test("failed description closes the partial transport before platform acquisition and preserves the typed error", async () => {
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
            return yield* makeTestRuntime({
                owner: "test",
                namespace: "failure",
                blobBytes: new MemoryBlobBytesStore(),
            });
        })
    );
    const client = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                released.push("transport");
            })
        );
        return yield* failure;
    });
    await expect(createLiveOntology({ ir, runtime: Runtimes.layer(runtime), client })).rejects.toBe(failure);
    expect(released).toEqual(["transport"]);
});
