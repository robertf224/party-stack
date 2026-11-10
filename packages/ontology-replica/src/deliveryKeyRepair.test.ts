import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR, type QueryDocument } from "@party-stack/ontology-spec";
import {
    eq,
    evaluateQuery,
    field,
    type Query,
    type Row,
    type OntologyStorageError,
} from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit, Scope, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type {
    TablesService,
    Transaction,
    TableQueryOptions,
    ReadTable,
} from "@party-stack/ontology-storage/tables";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "scope", displayName: "Scope", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        { name: "seed", displayName: "Seed", parameters: [], logic: [] },
        {
            name: "remove",
            displayName: "Remove",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            logic: [],
        },
        {
            name: "write",
            displayName: "Write",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "scope", displayName: "Scope", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
            logic: [],
        },
    ],
};

test.each(["committed", "speculative"] as const)(
    "%s delivery repairs wider cached identities without decoding installed pages",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const installed = Array.from({ length: 260 }, (_, n) => ({
                        key: `installed-${String(n).padStart(3, "0")}`,
                        value: { id: `installed-${String(n).padStart(3, "0")}`, scope: "a", rank: 260 - n },
                    }));
                    const wider = [
                        { key: "below-window", value: { id: "below-window", scope: "a", rank: -1 } },
                        { key: "remote-deleted", value: { id: "remote-deleted", scope: "a", rank: 1000 } },
                        { key: "outside", value: { id: "outside", scope: "b", rank: 0 } },
                        { key: "own-matches", value: { id: "own-matches", scope: "b", rank: 0 } },
                    ];
                    let server: Row<Record<string, unknown>>[] = [...installed, ...wider];
                    const backend = yield* makeOwnedBackend({
                        ir,
                        namespace: `key-repair-authority-${kind}`,
                        tables: yield* Memory.make(),
                        mutators: {
                            seed: (tx) =>
                                Effect.forEach(server, (row) => tx.put("Item", row.value), { discard: true }),
                            write: (tx, action) => tx.put("Item", { ...action.parameters }),
                            remove: (tx, action) => tx.delete("Item", String(action.parameters.id)),
                        },
                    });
                    yield* backend.applyAction({ id: "seed", name: "seed", parameters: {} });
                    const execute: Parameters<typeof makeReplica>[0]["execute"] = (tx, action) =>
                        tx.put("Item", { ...action.parameters });
                    const parent =
                        kind === "speculative"
                            ? yield* makeReplica({
                                  namespace: "key-repair-parent",
                                  ir,
                                  tables: yield* Memory.make(),
                                  backend,
                                  execute,
                                  startSync: false,
                                  objectCacheGc: false,
                                  demand: { refresh: { maxCoverageAgeMs: 0 } },
                              })
                            : undefined;
                    if (parent) {
                        yield* parent.demand({ objectType: "Item" });
                        yield* parent.syncOnce;
                    }
                    const source = parent ? replicaStateSource(parent) : undefined;
                    const namespace = `key-repair-child-${kind}`;
                    const storage = yield* Memory.make();
                    const baseName = JSON.stringify([
                        "replica",
                        namespace,
                        `${source ? "parent-base" : "base"}:Item`,
                    ]);
                    const inheritedName = JSON.stringify(["replica", namespace, "parent-overlay:Item"]);
                    let record = false,
                        valuePages = 0;
                    const keyPages: { limit: number | undefined; count: number }[] = [];
                    const tables: TablesService = {
                        ...storage,
                        transaction: (body) =>
                            storage.transaction((tx) => {
                                function query(
                                    document: QueryDocument,
                                    options: TableQueryOptions
                                ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
                                function query<A>(
                                    table: ReadTable<A>,
                                    options?: Query
                                ): Effect.Effect<Row<A>[], OntologyStorageError>;
                                function query<A>(
                                    table: QueryDocument | ReadTable<A>,
                                    options: Query | TableQueryOptions = {}
                                ) {
                                    if ("select" in table)
                                        return tx.query(table, options as TableQueryOptions);
                                    const scan = options as Query;
                                    if (
                                        record &&
                                        [baseName, inheritedName].includes(table.name) &&
                                        scan.limit === 128 &&
                                        !scan.where &&
                                        !scan.orderBy
                                    )
                                        valuePages++;
                                    return tx.query(table, scan);
                                }
                                const keys: Transaction["keys"] = (table, options) =>
                                    tx.keys(table, options).pipe(
                                        Effect.tap((values) =>
                                            Effect.sync(() => {
                                                if (record && [baseName, inheritedName].includes(table.name))
                                                    keyPages.push({
                                                        limit: options?.limit,
                                                        count: values.length,
                                                    });
                                            })
                                        )
                                    );
                                return body({ ...tx, query, keys });
                            }),
                    };
                    const child = yield* makeReplica({
                        namespace,
                        ir,
                        tables,
                        ...(source ? { source } : { backend }),
                        execute,
                        startSync: false,
                        objectCacheGc: false,
                    });
                    const transfer = Effect.fnUntraced(function* () {
                        yield* Effect.scoped(
                            Effect.gen(function* () {
                                const opened = yield* child.openParentDelivery(source);
                                const pull = yield* Stream.toPull(opened.subscription.frames);
                                for (;;)
                                    for (const frame of yield* pull) {
                                        const applied = yield* child.receiveDelivery(
                                            frame,
                                            opened.generation
                                        );
                                        if (!applied) continue;
                                        if (source && applied.metadata.client)
                                            yield* source.acknowledge(
                                                opened.session ?? applied.metadata.client,
                                                applied.metadata.revision,
                                                applied.metadata.client.deliveredThrough,
                                                applied.metadata.generation
                                            );
                                        yield* opened.subscription.acknowledge(applied.position);
                                        if (!applied.duplicate) return;
                                    }
                            })
                        );
                    });
                    const oldView = yield* Scope.fork(yield* Effect.scope);
                    yield* Scope.provide(child.demand({ objectType: "Item" }), oldView);
                    yield* transfer();
                    yield* Scope.close(oldView, Exit.void);
                    const optimistic = { id: "own-matches", scope: "a", rank: 2000 };
                    yield* child.enqueue({ id: "pending-write", name: "write", parameters: optimistic });
                    server = [
                        ...installed,
                        ...wider.filter((row) => ["outside", "own-matches"].includes(row.key)),
                    ];
                    for (const id of ["below-window", "remote-deleted"])
                        yield* backend.applyAction({
                            id: `delete-${id}`,
                            name: "remove",
                            parameters: { id },
                        });
                    if (parent) yield* parent.syncOnce;
                    const query: Query = {
                        where: eq(field("scope"), "a"),
                        orderBy: [{ field: field("rank"), direction: "desc" }],
                        limit: 260,
                    };
                    yield* child.demand({ objectType: "Item", query });
                    record = true;
                    yield* transfer();
                    record = false;
                    const oracle = server.map((row) =>
                        row.key === optimistic.id ? { key: row.key, value: optimistic } : row
                    );
                    expect(yield* child.loadSubset("Item", query)).toEqual(evaluateQuery(oracle, query));
                    expect(yield* child.confirmed.get("Item", "below-window")).toBeUndefined();
                    expect(yield* child.confirmed.get("Item", "remote-deleted")).toBeUndefined();
                    expect((yield* child.confirmed.get("Item", "outside"))?.scope).toBe("b");
                    expect(
                        yield* child.loadSubset("Item", { where: eq(field("id"), "own-matches") })
                    ).toEqual([{ key: "own-matches", value: optimistic }]);
                    expect((yield* child.actionStatus("pending-write")).pending).toBeDefined();
                    expect(valuePages).toBe(0);
                    expect(keyPages.reduce((total, page) => total + page.count, 0)).toBeGreaterThanOrEqual(
                        260
                    );
                    expect(keyPages.every((page) => page.limit === 128 && page.count <= 128)).toBe(true);
                })
            )
        );
    }
);
