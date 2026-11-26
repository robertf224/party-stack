import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, PubSub, Stream, SubscriptionRef } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplica } from "./make.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

const type = (name: string, extra: OntologyIR["objectTypes"][number]["properties"] = []) => ({
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    primaryKey: "id",
    properties: [{ name: "id", displayName: "Id", type: o.string({}) }, ...extra],
});
const v1: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [type("Item"), type("Other")],
};
const label = { name: "label", displayName: "Label", type: o.string({}) };

/** Metadata that can be edited and taken offline. Watches report each edit. */
const editableMetadata = (initial: OntologyIR, options: { readonly slow?: string } = {}) =>
    Effect.gen(function* () {
        let current = initial;
        let edited = false;
        let offline = false;
        const edits = yield* PubSub.unbounded<void>();
        const reads: string[] = [];
        const unavailable = () =>
            new BackendError({
                operation: "loadSubset",
                kind: "Unavailable",
                retryable: true,
                message: "Offline.",
            });
        const backend: OntologyBackendService = {
            ...makeMetadataBackend(initial),
            loadSubset: (subset) =>
                Effect.suspend(() => {
                    if (offline) return Effect.fail(unavailable());
                    const objectType = subset.from.source.objectType;
                    reads.push(objectType);
                    const load = makeMetadataBackend(current).loadSubset(subset);
                    // After an edit, this type's metadata arrives later than the rest.
                    return edited && objectType === options.slow ? Effect.delay(load, "300 millis") : load;
                }),
            query: (document, settings) =>
                offline ? Effect.fail(unavailable()) : makeMetadataBackend(current).query(document, settings),
            watchSubset: () =>
                Effect.map(PubSub.subscribe(edits), (subscription) =>
                    Stream.fromSubscription(subscription).pipe(Stream.as("reset" as const))
                ),
        };
        return {
            backend,
            reads,
            edit: (next: OntologyIR) =>
                Effect.suspend(() => {
                    current = next;
                    edited = true;
                    return PubSub.publish(edits, undefined);
                }),
            setOffline: (value: boolean) =>
                Effect.sync(() => {
                    offline = value;
                }),
        };
    });

const dataBackend = (ir: OntologyIR) =>
    makeOntologyBackend({
        ir,
        name: "data",
        sourceId: "data",
        supportsIdempotency: true,
        queryFunction: () => Effect.void,
        loadSubset: (request) =>
            Effect.map(compileObjectSubset(ir, request), (subset) => ({
                complete: true,
                rows: evaluateQuery(
                    subset.objectType === "Item" ? [{ key: "a", value: { id: "a" } }] : [],
                    subset.query ?? {}
                ),
            })),
        applyAction: (request) => Effect.succeed({ operationId: request.id, outcome: "committed" as const }),
    });

const names = (ir: OntologyIR) => ir.objectTypes.map((objectType) => objectType.name);
const itemProperties = (ir: OntologyIR) =>
    ir.objectTypes
        .find((objectType) => objectType.name === "Item")!
        .properties.map((property) => property.name);

test("a dynamic definition opens under the selected metadata and follows edits to it", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v1);
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "meta" });
                const replica = yield* makeReplica({
                    definition: {
                        kind: "dynamic",
                        meta: metadata.backend,
                        select: { objectTypeNames: ["Item"], actionTypeNames: [] },
                    },
                    backend: (ir) => Effect.sync(() => dataBackend(ir)),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                expect(names(replica.ir)).toEqual(["Item"]);

                const seen = yield* SubscriptionRef.make<OntologyIR[]>([]);
                yield* replica.definition.changes.pipe(
                    Stream.runForEach((ir) => SubscriptionRef.update(seen, (all) => [...all, ir])),
                    Effect.forkScoped
                );
                // A type outside the selection is not part of the definition.
                yield* metadata.edit({ ...v1, objectTypes: [type("Item"), type("Other", [label])] });
                // A selected type's edit reopens the replica under it.
                yield* metadata.edit({ ...v1, objectTypes: [type("Item", [label]), type("Other", [label])] });
                const reopened = yield* replica.definition.changes.pipe(
                    Stream.filter((ir) => itemProperties(ir).includes("label")),
                    Stream.runHead
                );
                expect(reopened._tag).toBe("Some");
                expect(names(replica.ir)).toEqual(["Item"]);
                yield* SubscriptionRef.changes(seen).pipe(
                    Stream.filter((all) => all.length >= 2),
                    Stream.runHead
                );
                expect((yield* SubscriptionRef.get(seen)).map(itemProperties)).toEqual([
                    ["id"],
                    ["id", "label"],
                ]);
                expect(
                    yield* replica.readSubset({ from: { source: { objectType: "Item" }, binding: "item" } })
                ).toEqual([]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a dynamic definition opens offline from the metadata it read before", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const metadata = yield* editableMetadata({
                ...v1,
                objectTypes: [type("Item", [label]), type("Other")],
            });
            // The storage outlives each replica, as a device's does across restarts.
            const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "offline" });
            const open = Effect.gen(function* () {
                return yield* makeReplica({
                    definition: {
                        kind: "dynamic",
                        meta: metadata.backend,
                        select: { objectTypeNames: ["Item"] },
                    },
                    backend: (ir) => Effect.sync(() => dataBackend(ir)),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
            });
            yield* Effect.scoped(
                Effect.map(open, (replica) => expect(itemProperties(replica.ir)).toEqual(["id", "label"]))
            );
            yield* metadata.setOffline(true);
            const reads = metadata.reads.length;
            yield* Effect.scoped(
                Effect.map(open, (replica) => expect(itemProperties(replica.ir)).toEqual(["id", "label"]))
            );
            expect(metadata.reads.length).toBe(reads);
        }).pipe(Effect.scoped, Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
    );
});

test("a SchemaMismatch from the data backend revalidates the metadata", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v1);
                // No watch: only the mismatch can tell the replica the metadata changed.
                const meta = { ...metadata.backend, watchSubset: undefined };
                let provider = v1;
                const runtime = yield* (yield* Runtimes).acquire({
                    owner: "anonymous",
                    namespace: "mismatch",
                });
                const replica = yield* makeReplica({
                    definition: { kind: "dynamic", meta },
                    backend: (ir) =>
                        Effect.sync(() => {
                            const backend = dataBackend(ir);
                            return {
                                ...backend,
                                loadSubset: (subset) =>
                                    ir === provider || itemProperties(ir).includes("label")
                                        ? backend.loadSubset(subset)
                                        : Effect.fail(
                                              new BackendError({
                                                  operation: "loadSubset",
                                                  kind: "SchemaMismatch",
                                                  retryable: false,
                                                  message: "Item changed.",
                                              })
                                          ),
                            };
                        }),
                    demand: { refresh: { pollIntervalMs: false } },
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                provider = { ...v1, objectTypes: [type("Item", [label]), type("Other")] };
                yield* metadata.edit(provider);
                const item = { from: { source: { objectType: "Item" }, binding: "item" } };
                expect(
                    yield* Effect.result(
                        Effect.scoped(replica.demand.acquire(item, { resultType: "complete" }))
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "SchemaMismatch" } });
                yield* replica.definition.changes.pipe(
                    Stream.filter((ir) => itemProperties(ir).includes("label")),
                    Stream.runHead
                );
                expect(itemProperties(replica.ir)).toEqual(["id", "label"]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("an edit whose metadata arrives in parts reopens the replica once, under all of it", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v1, { slow: "ValueType" });
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "parts" });
                const replica = yield* makeReplica({
                    definition: {
                        kind: "dynamic",
                        meta: metadata.backend,
                        select: { objectTypeNames: ["Item"] },
                    },
                    backend: (ir) => Effect.sync(() => dataBackend(ir)),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                const seen = yield* SubscriptionRef.make<OntologyIR[]>([]);
                yield* replica.definition.changes.pipe(
                    Stream.runForEach((ir) => SubscriptionRef.update(seen, (all) => [...all, ir])),
                    Effect.forkScoped
                );
                // Item gains a property of a new named value type, whose row reloads later.
                const status = { name: "status", displayName: "Status", type: o.ref({ name: "Status" }) };
                yield* metadata.edit({
                    ...v1,
                    types: [{ name: "Status", type: o.string({}) }],
                    objectTypes: [type("Item", [status]), type("Other")],
                });
                // Promptly: reading before the value type arrives would fail and wait for a retry.
                const reopened = yield* SubscriptionRef.changes(seen).pipe(
                    Stream.filter((all) => all.length >= 2),
                    Stream.runHead,
                    Effect.timeout("2 seconds")
                );
                expect(reopened._tag).toBe("Some");
                expect(itemProperties(replica.ir)).toEqual(["id", "status"]);
                expect((yield* replica.status.get).definition?.error).toBeUndefined();
                expect(replica.ir.types.map((valueType) => valueType.name)).toEqual(["Status"]);
                // Give a second reopen time to happen, then check there was none.
                yield* Effect.sleep("500 millis");
                expect((yield* SubscriptionRef.get(seen)).length).toBe(2);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
