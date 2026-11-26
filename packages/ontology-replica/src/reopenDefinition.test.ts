import { BackendError } from "@party-stack/ontology-backend";
import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Scope, Stream, SubscriptionRef } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplicaPartitionCatalog } from "./registry.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
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
        context: {},
        supportsIdempotency: true,
    };
    const catalog = yield* makeReplicaPartitionCatalog();
    const scope = yield* Scope.make();
    const opened = yield* Scope.provide(
        catalog.open("issues", { definition: { kind: "static", ir }, backend, bootstrap, live: false }),
        scope
    );
    const replacement = { ...bootstrap, definitionHash: "next" };
    // The app restarts under the new definition; the replica resets what changed as it opens.
    const reopen = Effect.andThen(
        Scope.close(scope, Exit.void),
        catalog.open("issues", {
            definition: { kind: "static", ir: next },
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

test("a dynamic replica reopens its partition offline, without reading its metadata first", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "source",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                let offline = false;
                let reads = 0;
                const metadata = makeMetadataBackend(ir);
                const meta: OntologyBackendService = {
                    ...metadata,
                    loadSubset: (subset) =>
                        Effect.suspend(() => {
                            reads++;
                            return offline
                                ? Effect.fail(
                                      new BackendError({
                                          operation: "loadSubset",
                                          kind: "Unavailable",
                                          retryable: true,
                                          message: "Offline.",
                                      })
                                  )
                                : metadata.loadSubset(subset);
                        }),
                    query: (document, settings) =>
                        offline
                            ? Effect.fail(
                                  new BackendError({
                                      operation: "query",
                                      kind: "Unavailable",
                                      retryable: true,
                                      message: "Offline.",
                                  })
                              )
                            : metadata.query(document, settings),
                };
                const catalog = yield* makeReplicaPartitionCatalog();
                // The partition's storage outlives each owner, as on a device.
                yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "issues" });
                const open = catalog.open("issues", {
                    definition: { kind: "dynamic", meta },
                    backend,
                    onDefinitionChange: "reset",
                });
                const first = yield* Effect.scoped(Effect.map(open, (opened) => opened.replica.ir));
                expect(first.objectTypes.map((type) => type.name)).toEqual(
                    ir.objectTypes.map((type) => type.name)
                );
                expect((yield* catalog.lookup("issues"))?.definition).toBeUndefined();
                offline = true;
                const before = reads;
                const restarted = yield* Effect.scoped(Effect.map(open, (opened) => opened.replica.ir));
                expect(restarted).toEqual(first);
                expect(reads).toBe(before);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
