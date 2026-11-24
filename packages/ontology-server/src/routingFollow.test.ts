import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeReplica } from "@party-stack/ontology-replica";
import { o } from "@party-stack/ontology-spec";
import { MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Stream, SubscriptionRef } from "effect";
import { expect, test } from "vite-plus/test";
import { makeOntologyServer } from "./routing.js";
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
                const source = yield* SubscriptionRef.make(v1);
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "follow" });
                const replica = yield* makeReplica({
                    definition: { changes: SubscriptionRef.changes(source) },
                    backend: (ir) => Effect.sync(() => backendFor(ir)),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                const server = yield* makeOntologyServer({
                    kind: "replica",
                    replica,
                    backend: backends.get(v1)!,
                    dangerouslyAllowInternalAccess: true,
                });
                const before = yield* Effect.scoped(server.bind(""));
                expect(before.options.ir).toBe(v1);

                yield* SubscriptionRef.set(source, v2);
                yield* replica.definition.changes.pipe(
                    Stream.filter((ir) => ir === v2),
                    Stream.runHead
                );
                const after = yield* Effect.scoped(server.bind(""));
                expect(after.options.ir).toBe(v2);
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
                const source = yield* SubscriptionRef.make(v1);
                const server = yield* makeOntologyServer({
                    routes: {
                        items: {
                            kind: "replica",
                            definition: { changes: SubscriptionRef.changes(source) },
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
                expect(before.options.ir).toBe(v1);
                const replica = before.options.replica!;
                yield* SubscriptionRef.set(source, v2);
                yield* replica.definition.changes.pipe(
                    Stream.filter((ir) => ir === v2),
                    Stream.runHead
                );
                const after = yield* Effect.scoped(server.bind("items"));
                expect(after.options.ir).toBe(v2);
                expect(after.options.replica).toBe(replica);
                expect(built).toEqual([v1, v2]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
