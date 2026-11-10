import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery, ontologyDefinitionContractSignature } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { MemoryRuntime, Runtimes, Runtime, MemoryBlobBytesStore } from "@party-stack/runtime";
import { Deferred, Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";
import { makeOntologyServer } from "./routing.js";
import { makeOntologyLocalClient } from "./rpcLocal.js";
import type { OntologyClient, OntologyServerClient } from "./rpc.js";
import type { PendingAction } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";

const definition = (text: boolean): OntologyIR => ({
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
                { name: "count", displayName: "Count", type: text ? o.string({}) : o.integer({}) },
            ],
        },
    ],
});
const original = definition(false),
    replacement = definition(true);
const same = (ir: OntologyIR | undefined, expected: OntologyIR) =>
    ir !== undefined &&
    ontologyDefinitionContractSignature(ir) === ontologyDefinitionContractSignature(expected);
const until = <A, E, R>(read: Effect.Effect<A, E, R>, ready: (value: A) => boolean) =>
    Effect.gen(function* () {
        const deadline = Date.now() + 3_000;
        for (;;) {
            const value = yield* read;
            if (ready(value)) return value;
            if (Date.now() > deadline) throw new Error("Automatic route rebuild did not settle");
            yield* Effect.yieldNow;
        }
    });
const setup = Effect.fnUntraced(function* (bundled = false) {
    const runtimes = yield* Runtimes;
    yield* runtimes.acquire({ owner: "replica-registry", namespace: "default" });
    const runtime = yield* runtimes.acquire({ owner: "anonymous", namespace: "notes" });
    const backend = (ir: OntologyIR) =>
        makeOntologyBackend({
            ir,
            name: "upstream",
            sourceId: "stable-upstream",
            supportsIdempotency: true,
            loadSubset: (request) =>
                compileObjectSubset(ir, request).pipe(
                    Effect.map((subset) => ({
                        rows: evaluateQuery(
                            [{ key: "row", value: { id: "row", count: same(ir, replacement) ? "new" : 1 } }],
                            subset.query
                        ),
                        complete: true,
                    }))
                ),
            applyAction: () =>
                Effect.fail(
                    new BackendError({
                        operation: "test",
                        kind: "Unavailable",
                        retryable: true,
                        message: "Keep offline intent pending",
                    })
                ),
            queryFunction: () => Effect.void,
        });
    let selected = original,
        source = backend(original);
    const remote = yield* makeOntologyServer({
        enableRealtime: true,
        routes: {
            remote: () =>
                Effect.succeed({
                    kind: "proxy" as const,
                    ir: selected,
                    backend: source,
                    context: {},
                    dangerouslyAllowInternalAccess: true as const,
                }),
        },
    });
    const transport = yield* makeOntologyLocalClient(remote);
    let acquired: OntologyClient | undefined;
    let freshRequests = 0;
    const fresh = yield* Deferred.make<void>();
    const upstream: OntologyServerClient = {
        ontology: (_name, options) =>
            transport.ontology("remote", options).pipe(
                Effect.tap((client) =>
                    Effect.gen(function* () {
                        if (options?.onIncompatible) acquired = client;
                        else {
                            freshRequests++;
                            yield* Deferred.succeed(fresh, undefined);
                        }
                    })
                )
            ),
    };
    const server = yield* makeOntologyServer({
        enableRealtime: true,
        replicas: {},
        routes: {
            notes: {
                kind: "replica",
                upstream: { client: upstream },
                context: {},
                live: false,
                definition: { onIncompatible: "rebuild", ...(bundled ? { ir: original } : {}) },
                dangerouslyAllowInternalAccess: true,
            },
        },
    });
    const first = yield* server.bind("notes");
    const replica = first.options.replica;
    if (!replica || !acquired) throw new Error("Managed replica was not acquired");
    yield* replica.demand.acquire(objectSubset("Item"));
    const client = acquired;
    return {
        server,
        runtime,
        first,
        replica,
        fresh,
        freshRequests: () => freshRequests,
        change: Effect.sync(() => {
            selected = replacement;
            source = backend(replacement);
        }).pipe(Effect.andThen(remote.invalidate("remote"))),
        refresh: client.definition.refresh,
    };
});

test("an automatic rebuild adopts a fresh descriptor and the next route bind uses its native definition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                expect(yield* f.replica.confirmed.get("Item", "row")).toEqual({ id: "row", count: 1 });
                yield* f.change;
                expect(yield* Effect.result(f.refresh)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                yield* until(
                    f.server.partitions,
                    (entries) => same(entries[0]?.definition?.ir, replacement) && !entries[0]?.rebuild
                );
                const rebound = yield* until(f.server.bind("notes"), (bound) =>
                    same(bound.options.ir, replacement)
                );
                expect(rebound.options.replica).not.toBe(f.replica);
                expect(yield* rebound.options.replica!.confirmed.get("Item", "row")).toBeUndefined();
                yield* rebound.options.replica!.demand.acquire(objectSubset("Item"));
                expect(yield* rebound.options.replica!.confirmed.get("Item", "row")).toEqual({
                    id: "row",
                    count: "new",
                });
                expect(f.freshRequests()).toBe(1);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a pending-action rebuild refusal keeps the existing route and cached rows usable", async () => {
    const blocked = Deferred.makeUnsafe<void>();
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const memory = yield* Memory.make();
            return yield* Runtime.make({
                blobBytes: new MemoryBlobBytesStore(),
                tables: {
                    ...memory,
                    read: (body) =>
                        memory
                            .read(body)
                            .pipe(
                                Effect.tapError((error) =>
                                    error instanceof BackendError &&
                                    error.operation === "replica.rebuild" &&
                                    error.kind === "Conflict"
                                        ? Deferred.succeed(blocked, undefined)
                                        : Effect.void
                                )
                            ),
                },
            });
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const pending: PendingAction = {
                    invocation: { id: "offline", name: "write", parameters: {} },
                    requestIdentity: "fixture",
                    createdAt: 0,
                    sequence: 1,
                    state: "queued",
                    optimistic: false,
                    attempts: 0,
                    touchedTypes: [],
                };
                const outbox = Table.make<PendingAction>({
                    name: JSON.stringify(["replica", "notes", "outbox"]),
                });
                yield* f.runtime.tables.put(outbox, "offline", pending);
                yield* f.change;
                expect(yield* Effect.result(f.refresh)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                yield* Deferred.await(f.fresh);
                yield* Deferred.await(blocked);
                // The refusal is observable through continued access, not a new owner
                // or a hand-maintained application cache.
                expect((yield* f.server.bind("notes")).options.replica).toBe(f.replica);
                expect(yield* f.replica.confirmed.get("Item", "row")).toEqual({ id: "row", count: 1 });
                expect(yield* f.runtime.tables.get(outbox, "offline")).toEqual(pending);
                expect((yield* f.server.partitions)[0]?.rebuild).toBeUndefined();
                expect(same((yield* f.server.partitions)[0]?.definition?.ir, original)).toBe(true);
            }).pipe(Effect.provide(Runtimes.layer(platform)))
        )
    );
});

test("a bundled application contract is never automatically rebuilt to a different upstream contract", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup(true);
                yield* f.change;
                expect(yield* Effect.result(f.refresh)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                yield* Deferred.await(f.fresh);
                expect((yield* f.server.bind("notes")).options.replica).toBe(f.replica);
                expect(yield* f.replica.confirmed.get("Item", "row")).toEqual({ id: "row", count: 1 });
                expect(same((yield* f.server.partitions)[0]?.definition?.ir, original)).toBe(true);
                expect((yield* f.server.partitions)[0]?.rebuild).toBeUndefined();
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
