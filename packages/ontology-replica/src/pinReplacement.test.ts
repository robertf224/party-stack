import { expect, it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { makeNetworkConnectivity } from "@party-stack/runtime";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { makeReplicaKernel } from "./engine.js";
import { makeQueryPin } from "./pins.js";
import type { DemandPolicy } from "./demandCache.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR, QueryDocument } from "@party-stack/ontology-spec";
import type { TablesService } from "@party-stack/ontology-storage/tables";

// Replacing one download's query in place is only reachable through a single query
// pin: named downloads add a new record and remove the old one instead.

const ir: OntologyIR = {
    types: [],
    linkTypes: [
        {
            id: "projectIssues",
            source: { objectType: "Issue", name: "issues", displayName: "Issues" },
            target: { objectType: "Project", name: "project", displayName: "Project" },
            foreignKey: "project",
            cardinality: "many",
        },
    ],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "project", displayName: "Project", type: o.string({}) },
            ],
        },
    ],
};
const document = (id: string): QueryDocument => ({
    select: [
        q.sub("projects", {
            from: { source: { objectType: "Project" }, binding: "p" },
            where: q.eq(q.field("p", "id"), q.literal(id)),
            select: [
                q.sub("issues", {
                    from: { source: q.related(q.local("p"), "issues"), binding: "i" },
                    select: [],
                }),
            ],
        }),
    ],
});
const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    const network = yield* makeNetworkConnectivity(true);
    const data: Record<string, Record<string, unknown>[]> = {
        Project: [{ id: "a" }, { id: "b" }, { id: "c" }],
        Issue: [
            { id: "one", project: "a" },
            { id: "two", project: "b" },
        ],
    };
    const backend: OntologyBackendService = makeOntologyBackend({
        ir,
        name: "pin-replacement",
        sourceId: "pin-replacement",
        supportsIdempotency: false,
        applyAction: () => Effect.die("No actions in this fixture"),
        queryFunction: () => Effect.void,
        loadSubset: (request) =>
            Effect.map(compileObjectSubset(ir, request), (subset) => ({
                complete: true,
                rows: evaluateQuery(
                    (data[subset.objectType] ?? []).map((value) => ({ key: value.id as string, value })),
                    subset.query
                ),
            })),
    });
    /** A kernel and one query pin over the given storage, as a replica owner would open them. */
    const open = (settings: {
        readonly namespace: string;
        readonly live: boolean;
        readonly tables?: TablesService;
        readonly backend?: OntologyBackendService;
        readonly demand?: DemandPolicy;
        readonly objectCacheGc?: false;
    }) =>
        Effect.gen(function* () {
            const store = settings.tables ?? tables;
            const engine = yield* makeReplicaKernel({
                tables: store,
                namespace: settings.namespace,
                ir,
                backend: settings.backend ?? backend,
                connectivity: network,
                demand: settings.demand,
                execute: () => Effect.void,
                startSync: settings.live,
                objectCacheGc: settings.objectCacheGc,
            });
            const pin = yield* makeQueryPin({
                engine,
                tables: store,
                namespace: settings.namespace,
                ir,
                live: settings.live,
                id: "download",
            });
            return { engine, pin };
        });
    return { tables, network, data, backend, open };
});

it.effect(
    "a replaced query keeps its complete graph across offline edits and restart until the new one installs",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const settings = { namespace: "pin-replace", live: false };
                const firstScope = yield* Scope.make();
                let { engine, pin } = yield* Scope.provide(f.open(settings), firstScope);
                yield* pin.setPin(document("a"));
                expect(yield* pin.pinStatus).toMatchObject({ ready: true });
                expect((yield* pin.pinStatus)?.retainedGraph).toBeUndefined();
                yield* f.network.set(false);
                yield* pin.setPin(document("b"));
                yield* pin.setPin(document("c"));
                expect(yield* pin.pinStatus).toMatchObject({
                    query: document("c"),
                    ready: false,
                    previousGraphRetained: true,
                    retainedGraph: { query: document("a"), attachments: "none" },
                });
                yield* engine.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* engine.get("Issue", "one")).toBeDefined();
                yield* Scope.close(firstScope, Exit.void);
                ({ engine, pin } = yield* f.open(settings));
                expect((yield* pin.pinStatus)?.retainedGraph).toMatchObject({ query: document("a") });
                yield* engine.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* engine.get("Issue", "one")).toBeDefined();
                yield* f.network.set(true);
                yield* engine.syncOnce;
                yield* pin.refresh;
                expect(yield* pin.pinStatus).toMatchObject({ ready: true, previousGraphRetained: false });
                expect((yield* pin.pinStatus)?.retainedGraph).toBeUndefined();
                yield* engine.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* engine.get("Issue", "one")).toBeUndefined();
                expect(yield* engine.get("Project", "c")).toBeDefined();
                yield* pin.clearPin();
                yield* engine.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* engine.get("Project", "c")).toBeUndefined();
                expect(yield* pin.pinStatus).toBeUndefined();
            })
        )
);

it.effect("a new generation of an unchanged query preserves its membership rows", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const roots = Table.make({ name: JSON.stringify(["replica", "pin-stable", "pins"]) });
            let writes = 0;
            const tables: TablesService = {
                ...f.tables,
                transaction: (body) =>
                    f.tables.transaction((tx) =>
                        body({
                            ...tx,
                            put: (table, key, value) => {
                                if (table.name === roots.name) writes++;
                                return tx.put(table, key, value);
                            },
                            delete: (table, key) => {
                                if (table.name === roots.name) writes++;
                                return tx.delete(table, key);
                            },
                            clear: (table) => {
                                if (table.name === roots.name) writes++;
                                return tx.clear(table);
                            },
                        })
                    ),
            };
            const { engine, pin } = yield* f.open({ namespace: "pin-stable", live: false, tables });
            yield* pin.setPin(document("a"));
            const before = yield* tables.query(roots);
            expect(before.length).toBeGreaterThan(0);
            writes = 0;
            yield* pin.setPin(document("a"));
            expect(yield* pin.pinStatus).toMatchObject({ ready: true });
            expect(writes).toBe(0);
            expect(yield* tables.query(roots)).toEqual(before);
            yield* pin.setPin(document("b"));
            expect(writes).toBeGreaterThan(0);
            yield* engine.collectGarbage({ minUnusedAgeMs: 0 });
            expect(yield* engine.get("Issue", "one")).toBeUndefined();
            expect(yield* engine.get("Issue", "two")).toBeDefined();
        })
    )
);

it.effect("replacing a query cancels its pending acquisition and cannot install the obsolete graph", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const entered = yield* Deferred.make<void>();
            const interrupted = yield* Deferred.make<void>();
            const { engine, pin } = yield* f.open({
                namespace: "pin-cancel",
                live: true,
                // Release is under test: no idle retention.
                demand: { idleRetentionMs: 0 },
                objectCacheGc: false,
                backend: {
                    ...f.backend,
                    loadSubset: (request) =>
                        Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                            JSON.stringify(subset.query).includes('"b"')
                                ? Deferred.succeed(entered, undefined).pipe(
                                      Effect.andThen(Effect.never),
                                      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
                                  )
                                : f.backend.loadSubset(request)
                        ),
                },
            });
            yield* pin.setPin(document("b"));
            yield* Deferred.await(entered);
            yield* pin.setPin(document("c"));
            yield* Deferred.await(interrupted);
            yield* engine.syncOnce;
            yield* pin.refresh;
            expect(yield* pin.pinStatus).toMatchObject({ query: document("c"), ready: true });
            yield* pin.clearPin();
        })
    )
);

it.effect("pin commands accept newer intent while obsolete acquisition cleanup is held", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const engine = yield* makeReplicaKernel({
                tables: f.tables,
                backend: f.backend,
                namespace: "pin-command",
                ir,
                execute: () => Effect.void,
                startSync: false,
                objectCacheGc: false,
            });
            const waiting = yield* Deferred.make<void>();
            const cleanup = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const pin = yield* makeQueryPin({
                tables: f.tables,
                namespace: "pin-command",
                ir,
                live: true,
                engine: {
                    ...engine,
                    demand: (subset) =>
                        JSON.stringify(subset.query).includes('"b"')
                            ? Effect.addFinalizer(() =>
                                  Deferred.succeed(cleanup, undefined).pipe(
                                      Effect.andThen(Deferred.await(release))
                                  )
                              )
                            : Effect.void,
                    syncSubset: () => Effect.void,
                    hasCoverage: () => Effect.succeed(true),
                    snapshotSubset: (subset) =>
                        Deferred.succeed(waiting, undefined).pipe(
                            Effect.as({ complete: !JSON.stringify(subset.query).includes('"b"'), rows: [] })
                        ),
                    subscribeChanges: Effect.succeed(Stream.never),
                    visibleChanges: Effect.succeed(Stream.never),
                },
            });
            try {
                yield* pin.setPin(document("b"));
                yield* Deferred.await(waiting);
                yield* pin.setPin(document("c"));
                yield* Deferred.await(cleanup);
                // Neither clearing nor another set waits for the held finalizer.
                yield* pin.clearPin();
                expect(yield* pin.pinStatus).toBeUndefined();
                yield* pin.setPin(document("a"));
                expect(yield* pin.pinStatus).toMatchObject({ query: document("a"), ready: false });
            } finally {
                yield* Deferred.succeed(release, undefined);
            }
            yield* Effect.all([pin.setPin(document("b")), pin.clearPin(), pin.setPin(document("a"))], {
                concurrency: "unbounded",
            });
            yield* pin.refresh;
            expect(yield* pin.pinStatus).toMatchObject({ query: document("a"), ready: true });
        })
    )
);
