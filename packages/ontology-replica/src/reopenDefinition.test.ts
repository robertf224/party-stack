import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Scope, Stream, SubscriptionRef } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplicaPartitionCatalog } from "./registry.js";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type { PendingAction } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
};
const next: OntologyIR = {
    ...ir,
    objectTypes: [
        {
            ...ir.objectTypes[0]!,
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.string({}) },
            ],
        },
    ],
};
const table = <A = unknown>(part: string) =>
    Table.make<A>({ name: JSON.stringify(["replica", "issues", part]) });
const pending: PendingAction = {
    invocation: { id: "pending", name: "write", parameters: {} },
    requestIdentity: "fixture",
    createdAt: 0,
    sequence: 1,
    state: "queued",
    optimistic: false,
    attempts: 0,
};

const setup = Effect.gen(function* () {
    const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "issues" });
    const backend = yield* makeOwnedBackend({
        ir,
        namespace: "source",
        tables: yield* Memory.make(),
        mutators: {},
    });
    const bootstrap: OntologyDescription = {
        version: 1,
        replication: "committed",
        sourceId: backend.sourceId,
        ir,
        context: {},
        supportsIdempotency: true,
    };
    const catalog = yield* makeReplicaPartitionCatalog();
    const scope = yield* Scope.make();
    const opened = yield* Scope.provide(
        catalog.open("issues", { definition: ir, backend, bootstrap, live: false }),
        scope
    );
    const replacement = { ...bootstrap, ir: next };
    // The app restarts under the new definition; the replica resets what changed as it opens.
    const reopen = Effect.andThen(
        Scope.close(scope, Exit.void),
        catalog.open("issues", {
            definition: next,
            backend,
            bootstrap: replacement,
            live: false,
            onDefinitionChange: "reset",
        })
    );
    return { catalog, runtime, backend, opened, replacement, reopen };
});

test("reopening under a new definition drops changed types' rows and keeps outcomes, source identity and desired downloads", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { catalog, runtime, reopen } = yield* setup;
                yield* runtime.tables.put(table("base:Item"), "old", { id: "old", count: 1 });
                yield* runtime.tables.put(table("coverage"), "old", { complete: true });
                const desired = {
                    generation: "desired",
                    query: { select: [] },
                    inputs: { label: "saved" },
                    attachments: "all",
                };
                yield* runtime.tables.put(table("query-pin"), "download", {
                    desired,
                    installed: desired,
                    error: { kind: "Unavailable", message: "old" },
                });
                const outcome = { ...pending, completedAt: 1 };
                const outcomes = [
                    "completed",
                    "parent-completed",
                    "journal-receipts",
                    "clients",
                    "submissions",
                ];
                for (const part of outcomes) yield* runtime.tables.put(table(part), "retained", outcome);
                const reopened = yield* reopen;
                expect(yield* reopened.replica.confirmed.get("Item", "old")).toBeUndefined();
                expect(
                    yield* runtime.tables.get(table<{ desired: unknown }>("query-pin"), "download")
                ).toMatchObject({
                    desired,
                });
                for (const part of outcomes)
                    expect(yield* runtime.tables.get(table(part), "retained")).toEqual(outcome);
                expect((yield* catalog.lookup("issues"))?.definition?.ir).toEqual(next);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("reopening under a new definition keeps own pending intent and accepted parent intent", async () => {
    for (const part of ["outbox", "parent-pending"])
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const { runtime, reopen } = yield* setup;
                    yield* runtime.tables.put(table(part), "pending", pending);
                    yield* runtime.tables.put(table("base:Item"), "old", { id: "old", count: 1 });
                    yield* reopen;
                    expect(yield* runtime.tables.get(table("base:Item"), "old")).toBeUndefined();
                    expect(
                        (yield* runtime.tables.get(table<PendingAction>(part), "pending"))?.invocation
                    ).toEqual(pending.invocation);
                }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
            )
        );
});

test("a followed replica records each definition it reopens under and starts under it without its source", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "source",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const catalog = yield* makeReplicaPartitionCatalog();
                const source = yield* SubscriptionRef.make(ir);
                const scope = yield* Scope.make();
                const opened = yield* Scope.provide(
                    catalog.open("issues", {
                        definition: { changes: SubscriptionRef.changes(source) },
                        backend,
                        live: false,
                        onDefinitionChange: "reset",
                    }),
                    scope
                );
                yield* SubscriptionRef.set(source, next);
                yield* opened.replica.definition.changes.pipe(
                    Stream.filter((value) => value === next),
                    Stream.runHead
                );
                // Recorded after the reopen.
                yield* Effect.yieldNow;
                for (let attempt = 0; attempt < 20; attempt++) {
                    if ((yield* catalog.lookup("issues"))?.definition?.ir === next) break;
                    yield* Effect.sleep("5 millis");
                }
                expect((yield* catalog.lookup("issues"))?.definition?.ir).toEqual(next);
                yield* Scope.close(scope, Exit.void);
                // Offline: the source never answers, and the replica opens under the retained one.
                const restarted = yield* catalog.open("issues", {
                    definition: { changes: Stream.never },
                    backend,
                    live: false,
                    onDefinitionChange: "reset",
                });
                expect(restarted.replica.ir).toEqual(next);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
