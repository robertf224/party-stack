import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Effect, Exit, Layer, Scope } from "effect";
import { expect, test } from "vite-plus/test";
import { createOntologyClient } from "./client.js";
import { createLiveOntology } from "./live/LiveOntology.js";
import { localClient } from "./local.js";

const ir = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};

const makeBackend = Effect.fnUntraced(function* () {
    const backend = yield* makeOwnedBackend({
        namespace: "local-sdk",
        ir,
        tables: yield* Memory.make(),
        mutators: {},
    });
    yield* backend.storage.transaction((tx) => tx.put("Item", { id: "one" }));
    return backend;
});

test("localClient lazily owns a server and opens an SDK memory view over its managed parent", async () => {
    let opened = 0;
    let closed = 0;
    const server = Effect.gen(function* () {
        yield* Effect.acquireRelease(
            Effect.sync(() => opened++),
            () => Effect.sync(() => closed++)
        );
        const platform = yield* Layer.build(Runtimes.layer(MemoryRuntime.layer));
        return yield* makeOntologyServer({
            enableRealtime: true,
            replicas: {},
            routes: {
                "workspaces/demo": {
                    kind: "replica",
                    ir,
                    backend: yield* makeBackend(),
                    dangerouslyAllowInternalAccess: true,
                },
            },
        }).pipe(Effect.provideContext(platform));
    });
    const transport = localClient(server);
    expect(opened).toBe(0);
    const client = await createOntologyClient(transport);
    try {
        const live = await createLiveOntology({ client, ontology: "workspaces/demo" });
        try {
            expect(await queryOnce((q) => q.from({ item: live.objects.Item! }))).toMatchObject([
                { id: "one" },
            ]);
            expect(live.diagnostics?.parent).toBeDefined();
            expect({ opened, closed }).toEqual({ opened: 1, closed: 0 });
        } finally {
            await live.cleanup();
        }
        expect(closed).toBe(0);
    } finally {
        await Promise.all([client.cleanup(), client.cleanup()]);
    }
    expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
});

test("closing a local client leaves a borrowed server usable", async () => {
    const owner = Effect.runSync(Scope.make());
    let closed = false;
    try {
        const server = await Effect.runPromise(
            Scope.provide(
                Effect.gen(function* () {
                    yield* Effect.addFinalizer(() => Effect.sync(() => (closed = true)));
                    return yield* makeOntologyServer({
                        enableRealtime: true,
                        routes: {
                            items: {
                                kind: "owned",
                                backend: yield* makeBackend(),
                                dangerouslyAllowInternalAccess: true,
                            },
                        },
                    });
                }),
                owner
            )
        );
        const first = await createOntologyClient(localClient(server, { ontology: "items" }));
        await first.cleanup();
        expect(closed).toBe(false);
        const second = await createOntologyClient(localClient(server, { ontology: "items" }));
        try {
            const rows = await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const selected = yield* second.ontology();
                        return (yield* selected.backend.loadSubset(objectSubset("Item"))).rows;
                    })
                )
            );
            expect(rows).toEqual([{ key: "one", value: { id: "one" } }]);
        } finally {
            await second.cleanup();
        }
    } finally {
        await Effect.runPromise(Scope.close(owner, Exit.void));
    }
    expect(closed).toBe(true);
});

test("a failed local server factory releases its partial acquisition immediately", async () => {
    let closed = false;
    const failure = new BackendError({
        operation: "local.startup",
        kind: "Unavailable",
        retryable: true,
        message: "Storage unavailable",
    });
    const server = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => (closed = true)));
        return yield* failure;
    });
    await expect(createOntologyClient(localClient(server))).rejects.toBe(failure);
    expect(closed).toBe(true);
});
