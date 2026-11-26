import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeMetadataBackend, pull } from "@party-stack/ontology-backend/meta";
import { makeReplica } from "@party-stack/ontology-replica";
import { o } from "@party-stack/ontology-spec";
import { MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Fiber, PubSub, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { makeOntologyServer } from "./routing.js";
import { makeOntologyLocalClient } from "./rpcLocal.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

const definition = (extra: OntologyIR["objectTypes"][number]["properties"] = []): OntologyIR => ({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }, ...extra],
        },
    ],
});
const v1 = definition();
const v2 = definition([{ name: "label", displayName: "Label", type: o.string({}) }]);
const labelled = (ir: OntologyIR) =>
    ir.objectTypes[0]!.properties.some((property) => property.name === "label");

/** Metadata whose definition can be edited. Watches report each edit. */
const editableMetadata = (initial: OntologyIR) =>
    Effect.gen(function* () {
        let current = initial;
        const edits = yield* PubSub.unbounded<void>();
        const backend: OntologyBackendService = {
            ...makeMetadataBackend(initial),
            loadSubset: (subset) => Effect.suspend(() => makeMetadataBackend(current).loadSubset(subset)),
            query: (document, settings) =>
                Effect.suspend(() => makeMetadataBackend(current).query(document, settings)),
            watchSubset: () =>
                Effect.map(PubSub.subscribe(edits), (subscription) =>
                    Stream.fromSubscription(subscription).pipe(Stream.as("reset" as const))
                ),
        };
        return {
            backend,
            edit: (next: OntologyIR) =>
                Effect.suspend(() => {
                    current = next;
                    return PubSub.publish(edits, undefined);
                }),
        };
    });
const until = (changes: Stream.Stream<OntologyIR, unknown>, predicate: (ir: OntologyIR) => boolean) =>
    changes.pipe(Stream.filter(predicate), Stream.runHead);

test("a replica binding serves the definition and backend its replica is open under now", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backends = new Map<OntologyIR, ReturnType<typeof makeOntologyBackend>>();
                const backendFor = (ir: OntologyIR) => {
                    const backend = makeOntologyBackend({
                        ir,
                        name: "follow",
                        sourceId: "follow",
                        supportsIdempotency: true,
                        queryFunction: () => Effect.void,
                        loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                        applyAction: (request) =>
                            Effect.succeed({ operationId: request.id, outcome: "committed" as const }),
                    });
                    backends.set(ir, backend);
                    return backend;
                };
                const metadata = yield* editableMetadata(v1);
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "follow" });
                const replica = yield* makeReplica({
                    definition: { kind: "dynamic", meta: metadata.backend },
                    backend: (ir) => Effect.sync(() => backendFor(ir)),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                const server = yield* makeOntologyServer({
                    kind: "replica",
                    replica,
                    backend: backends.get(replica.ir)!,
                    dangerouslyAllowInternalAccess: true,
                });
                const before = yield* Effect.scoped(server.bind(""));
                expect(before.options.ir).toBe(replica.ir);
                expect(labelled(before.options.ir!)).toBe(false);

                yield* metadata.edit(v2);
                yield* until(replica.definition.changes, labelled);
                const after = yield* Effect.scoped(server.bind(""));
                expect(after.options.ir).toBe(replica.ir);
                expect(labelled(after.options.ir!)).toBe(true);
                expect(after).not.toBe(before);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a managed route can follow a definition and build its backend for each one", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const built: OntologyIR[] = [];
                const metadata = yield* editableMetadata(v1);
                const server = yield* makeOntologyServer({
                    routes: {
                        items: {
                            kind: "replica",
                            definition: { kind: "dynamic", meta: metadata.backend },
                            backend: (ir) =>
                                Effect.sync(() => {
                                    built.push(ir);
                                    return makeOntologyBackend({
                                        ir,
                                        name: "follow",
                                        sourceId: "follow",
                                        supportsIdempotency: true,
                                        queryFunction: () => Effect.void,
                                        loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                                        applyAction: (request) =>
                                            Effect.succeed({
                                                operationId: request.id,
                                                outcome: "committed" as const,
                                            }),
                                    });
                                }),
                            onDefinitionChange: "reset",
                            dangerouslyAllowInternalAccess: true,
                        },
                    },
                });
                const before = yield* Effect.scoped(server.bind("items"));
                expect(labelled(before.options.ir!)).toBe(false);
                const replica = before.options.replica!;
                yield* metadata.edit(v2);
                yield* until(replica.definition.changes, labelled);
                const after = yield* Effect.scoped(server.bind("items"));
                expect(labelled(after.options.ir!)).toBe(true);
                expect(after.options.replica).toBe(replica);
                expect(built.map(labelled)).toEqual([false, true]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a client bound to the old definition gets SchemaMismatch after the replica reopens", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v1);
                const server = yield* makeOntologyServer({
                    routes: {
                        items: {
                            kind: "replica",
                            definition: { kind: "dynamic", meta: metadata.backend },
                            backend: (ir) =>
                                Effect.succeed(
                                    makeOntologyBackend({
                                        ir,
                                        name: "fence",
                                        sourceId: "fence",
                                        supportsIdempotency: true,
                                        queryFunction: () => Effect.void,
                                        loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                                        applyAction: (request) =>
                                            Effect.succeed({
                                                operationId: request.id,
                                                outcome: "committed" as const,
                                            }),
                                    })
                                ),
                            onDefinitionChange: "reset",
                            dangerouslyAllowInternalAccess: true,
                        },
                    },
                });
                const transport = yield* makeOntologyLocalClient(server);
                const client = yield* transport.ontology("items");
                const item = { from: { source: { objectType: "Item" }, binding: "item" } };
                yield* client.backend.loadSubset(item);

                const replica = (yield* Effect.scoped(server.bind("items"))).options.replica!;
                yield* metadata.edit(v2);
                yield* until(replica.definition.changes, labelled);
                expect(yield* Effect.result(client.backend.loadSubset(item))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                // The client's definition status reports it, and a fresh client binds to v2.
                yield* client.definition.changes.pipe(
                    Stream.filter((status) => status.status === "incompatible" && !status.refreshing),
                    Stream.runHead
                );
                expect(yield* client.definition.get).toMatchObject({
                    status: "incompatible",
                    error: { kind: "SchemaMismatch" },
                });
                const fresh = yield* transport.ontology("items");
                expect(labelled(fresh.ir!)).toBe(true);
                expect(yield* fresh.backend.loadSubset(item)).toMatchObject({ rows: [] });
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

const itemsRoute = (meta: OntologyBackendService) => ({
    kind: "replica" as const,
    definition: { kind: "dynamic" as const, meta },
    backend: (ir: OntologyIR) =>
        Effect.succeed(
            makeOntologyBackend({
                ir,
                name: "items",
                sourceId: "items",
                supportsIdempotency: true,
                queryFunction: () => Effect.void,
                loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                applyAction: (request) =>
                    Effect.succeed({ operationId: request.id, outcome: "committed" as const }),
            })
        ),
    onDefinitionChange: "reset" as const,
    dangerouslyAllowInternalAccess: true as const,
});

test("a route serves its definition as meta ontology rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v2);
                const server = yield* makeOntologyServer({ routes: { items: itemsRoute(metadata.backend) } });
                const transport = yield* makeOntologyLocalClient(server);
                const client = yield* transport.ontology("items");
                expect(client.description.meta).toBe(true);
                const served = yield* pull(yield* client.metaBackend!);
                expect(served).toEqual(client.ir);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a client that makes no requests learns that the route's definition changed", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v1);
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    routes: { items: itemsRoute(metadata.backend) },
                });
                const transport = yield* makeOntologyLocalClient(server);
                const client = yield* transport.ontology("items");
                // Following the status watches the route's metadata.
                const incompatible = yield* client.definition.changes.pipe(
                    Stream.filter((status) => status.status === "incompatible"),
                    Stream.runHead,
                    Effect.forkScoped
                );
                yield* metadata.edit(v2);
                const status = yield* Fiber.join(incompatible);
                expect(status).toMatchObject({ _tag: "Some", value: { error: { kind: "SchemaMismatch" } } });
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
