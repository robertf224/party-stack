import { BackendError } from "@party-stack/ontology-backend";
import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { makeOntologyServer } from "./routing.js";
import { makeOntologyLocalClient } from "./rpcLocal.js";
import type { OntologyServerClient } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

const property = (name: string) => ({ name, displayName: name, type: o.string({}) });
const ir = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    context: { type: o.struct({ fields: [property("userId")] }), partition: [["userId"]] },
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [property("id")],
        },
    ],
};
const context = { userId: "alice" };

test("managed routes reopen retained data without a Describe preflight", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const runtimes = yield* Runtimes;
                // Keep the memory driver alive between owners to model durable storage.
                yield* runtimes.acquire({ owner: "replica-registry", namespace: "default" });
                yield* runtimes.acquire({ owner: contextPartition(ir, context), namespace: "notes" });
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "bootstrap-upstream",
                    mutators: {},
                });
                yield* backend.storage.transaction((tx) => tx.put("Note", { id: "retained" }));
                const upstreamServer = yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "owned",
                    ir,
                    backend,
                    context,
                    dangerouslyAllowInternalAccess: true,
                });
                const transport = yield* makeOntologyLocalClient(upstreamServer);
                let offline = false;
                let descriptions = 0;
                const upstream: OntologyServerClient = {
                    ontology: (name, options) =>
                        Effect.suspend(() => {
                            if (!options?.description) {
                                // Reading the definition from the `meta` resource is not a Describe.
                                if (!options?.resource) descriptions++;
                                if (offline)
                                    return Effect.fail(
                                        new BackendError({
                                            operation: "describe",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Offline",
                                        })
                                    );
                            }
                            return transport.ontology(name, options);
                        }),
                };
                const open = makeOntologyServer({
                    enableRealtime: true,
                    replicas: {},
                    routes: {
                        notes: {
                            kind: "replica",
                            upstream: { client: upstream },
                            context,
                            live: false,
                            dangerouslyAllowInternalAccess: true,
                        },
                    },
                });
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const server = yield* open;
                        const bound = yield* server.bind("notes");
                        yield* bound.options.replica!.demand.acquire(objectSubset("Note"));
                        expect(yield* bound.options.replica!.readSubset(objectSubset("Note"))).toHaveLength(
                            1
                        );
                    })
                );
                expect(descriptions).toBe(1);
                offline = true;
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const server = yield* open;
                        const bound = yield* server.bind("notes");
                        expect(yield* bound.options.replica!.readSubset(objectSubset("Note"))).toEqual([
                            { key: "retained", value: { id: "retained" } },
                        ]);
                    })
                );
                expect(descriptions).toBe(1);
                const other = yield* makeOntologyServer({
                    enableRealtime: true,
                    replicas: {},
                    routes: {
                        notes: {
                            kind: "replica",
                            upstream: { client: upstream },
                            context: { userId: "bob" },
                            live: false,
                            dangerouslyAllowInternalAccess: true,
                        },
                    },
                });
                expect(yield* Effect.result(other.bind("notes"))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unavailable" },
                });
                expect(descriptions).toBe(2);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a dynamic route reopens its account's partition from cached metadata", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const runtimes = yield* Runtimes;
                // Keep the memory driver alive between owners to model durable storage.
                yield* runtimes.acquire({ owner: "replica-registry", namespace: "default" });
                yield* runtimes.acquire({ owner: contextPartition(ir, context), namespace: "notes" });
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "native-bootstrap",
                    mutators: {},
                });
                const metadata = makeMetadataBackend(ir);
                let reads = 0;
                const meta: OntologyBackendService = {
                    ...metadata,
                    loadSubset: (subset) => Effect.suspend(() => (reads++, metadata.loadSubset(subset))),
                    query: (document, settings) =>
                        Effect.suspend(() => (reads++, metadata.query(document, settings))),
                };
                let selected = context;
                const open = makeOntologyServer({
                    enableRealtime: true,
                    replicas: {},
                    routes: {
                        notes: {
                            dangerouslyAllowInternalAccess: true,
                            open: () =>
                                Effect.succeed({
                                    kind: "replica" as const,
                                    definition: { kind: "dynamic" as const, meta },
                                    backend,
                                    context: selected,
                                    live: false,
                                }),
                        },
                    },
                });
                const acquire = Effect.scoped(
                    Effect.gen(function* () {
                        const server = yield* open;
                        return (yield* server.bind("notes")).options.ir;
                    })
                );
                expect((yield* acquire)?.objectTypes.map((type) => type.name)).toEqual(["Note"]);
                const first = reads;
                expect(first).toBeGreaterThan(0);
                // The same account reopens without reading the metadata backend.
                yield* acquire;
                expect(reads).toBe(first);
                // Another account reads its definition into its own partition.
                selected = { userId: "bob" };
                yield* acquire;
                expect(reads).toBeGreaterThan(first);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
