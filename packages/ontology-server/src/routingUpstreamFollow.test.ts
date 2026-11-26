import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import {
    evaluateQuery,
    ontologyDefinitionContractHash,
    ontologyDefinitionContractSignature,
} from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect, Fiber } from "effect";
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
            if (Date.now() > deadline) throw new Error("The route did not follow the new definition");
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
            remote: {
                dangerouslyAllowInternalAccess: true,
                open: () =>
                    Effect.succeed({
                        kind: "proxy" as const,
                        ir: selected,
                        backend: source,
                        context: {},
                    }),
            },
        },
    });
    const transport = yield* makeOntologyLocalClient(remote);
    let acquired: OntologyClient | undefined;
    let describes = 0;
    const upstream: OntologyServerClient = {
        ontology: (_name, options) =>
            transport.ontology("remote", options).pipe(
                Effect.tap((client) =>
                    Effect.sync(() => {
                        // The replica's own client; the first open also describes the upstream once.
                        if (options?.validate) acquired ??= client;
                        else if (!options?.resource) describes++;
                    })
                )
            ),
    };
    let opens = 0;
    const server = yield* makeOntologyServer({
        enableRealtime: true,
        replicas: {},
        routes: {
            notes: {
                dangerouslyAllowInternalAccess: true,
                open: Effect.sync(() => {
                    opens++;
                    return {
                        kind: "replica" as const,
                        upstream: { client: upstream },
                        context: {},
                        live: false,
                        onDefinitionChange: "reset" as const,
                        ...(bundled ? { ir: original } : {}),
                    };
                }),
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
        describes: () => describes,
        opens: () => opens,
        change: Effect.sync(() => {
            selected = replacement;
            source = backend(replacement);
        }).pipe(Effect.andThen(remote.invalidate("remote"))),
        refresh: client.definition.refresh,
    };
});

test("an upstream definition change reopens the route's replica in place, without failing binds", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                expect(yield* f.replica.confirmed.get("Item", "row")).toEqual({ id: "row", count: 1 });
                // Keep binding the route and reading through it, as requests do, for the whole change.
                let binding = true;
                const failures: unknown[] = [];
                const binds = yield* Effect.forkScoped(
                    Effect.gen(function* () {
                        while (binding) {
                            const exit = yield* Effect.exit(
                                Effect.scoped(
                                    Effect.flatMap(f.server.bind("notes"), (bound) =>
                                        bound.options.replica!.confirmed.get("Item", "row")
                                    )
                                )
                            );
                            if (exit._tag === "Failure") failures.push(exit.cause);
                            yield* Effect.yieldNow;
                        }
                    })
                );
                yield* f.change;
                // The client describes the upstream again; following, the replica reads the new
                // definition from the upstream's metadata.
                yield* f.refresh;
                const rebound = yield* until(f.server.bind("notes"), (bound) =>
                    same(bound.options.ir, replacement)
                );
                binding = false;
                yield* Fiber.join(binds);
                expect(failures).toEqual([]);
                // One route, one replica handle: the replica reopened behind it.
                expect(f.opens()).toBe(1);
                expect(rebound.options.replica).toBe(f.replica);
                expect(f.describes()).toBe(1);
                // The demand held across the reopen loads the changed type in its new shape.
                yield* until(f.replica.confirmed.get("Item", "row"), (row) => row?.count === "new");
                // The catalog keeps the refreshed binding, not the definition.
                const contract = yield* ontologyDefinitionContractHash(replacement);
                const [saved] = yield* until(
                    f.server.partitions,
                    (entries) => entries[0]?.bootstrap?.contractHash === contract
                );
                expect(saved?.definition).toBeUndefined();
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("queued actions are kept and replayed when the replica follows a new upstream definition", async () => {
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
                };
                const outbox = Table.make<PendingAction>({
                    name: JSON.stringify(["replica", "notes", "outbox"]),
                });
                yield* f.runtime.tables.put(outbox, "offline", pending);
                yield* f.change;
                yield* f.refresh;
                yield* until(f.server.bind("notes"), (bound) => same(bound.options.ir, replacement));
                // Opening under the new definition replayed the queued action and recorded its
                // prediction status.
                const kept = yield* until(
                    f.runtime.tables.get(outbox, "offline"),
                    (row) => row?.prediction !== undefined
                );
                expect(kept?.invocation).toEqual(pending.invocation);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a bundled application contract is never replaced by a different upstream contract", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup(true);
                yield* f.change;
                expect(yield* Effect.result(f.refresh)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                const bound = yield* f.server.bind("notes");
                expect(bound.options.replica).toBe(f.replica);
                expect(same(bound.options.ir, original)).toBe(true);
                expect(yield* f.replica.confirmed.get("Item", "row")).toEqual({ id: "row", count: 1 });
                expect((yield* f.server.partitions)[0]?.bootstrap?.contractHash).toBe(
                    yield* ontologyDefinitionContractHash(original)
                );
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
