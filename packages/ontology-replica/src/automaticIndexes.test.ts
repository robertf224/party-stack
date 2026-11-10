import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Option, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";
import type { Index, Query } from "@party-stack/ontology-storage";
import type { ReadTable, TablesService, Transaction } from "@party-stack/ontology-storage/tables";

const ir: OntologyIR = {
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
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
};

test("automatic PK queries reuse the initialized unique index, without changing explicit index installation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const memory = yield* Memory.make();
                const baseName = JSON.stringify(["replica", "automatic-pk", "base:Item"]);
                const installed: Index[] = [];
                let decoded = 0;
                const track = (tx: Transaction): Transaction => ({
                    ...tx,
                    ensureIndex: (table, index) =>
                        Effect.andThen(
                            Effect.sync(() => {
                                if (table.name === baseName) installed.push(index);
                            }),
                            tx.ensureIndex(table, index)
                        ),
                });
                const tables: TablesService = {
                    ...memory,
                    ensureIndex: (table, index) =>
                        Effect.andThen(
                            Effect.sync(() => {
                                if (table.name === baseName) installed.push(index);
                            }),
                            memory.ensureIndex(table, index)
                        ),
                    transaction: (body) => memory.transaction((tx) => body(track(tx))),
                    read: (body) =>
                        memory.read((tx) =>
                            body({
                                ...tx,
                                query: new Proxy(tx.query, {
                                    apply(target, receiver, args) {
                                        const request = args[0] as ReadTable<unknown>;
                                        if ("select" in request || request.name !== baseName)
                                            return Reflect.apply(target, receiver, args);
                                        return Reflect.apply(target, receiver, [
                                            {
                                                ...request,
                                                decode: (encoded: string) => {
                                                    decoded++;
                                                    return request.decode(encoded);
                                                },
                                            },
                                            args[1],
                                        ]);
                                    },
                                }),
                            })
                        ),
                };
                const backend = yield* makeOwnedBackend({
                    namespace: "authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* backend.storage.transaction((tx) =>
                    Effect.forEach(
                        Array.from({ length: 300 }, (_, rank) => ({ id: `item-${rank}`, rank })),
                        (row) => tx.put("Item", row),
                        { discard: true }
                    )
                );
                const replica = yield* makeReplica({
                    namespace: "automatic-pk",
                    ir,
                    tables,
                    backend,
                    execute: () => Effect.die("A lookup cannot execute an action."),
                    startSync: false,
                    live: false,
                });
                yield* replica.demand({ objectType: "Item" });
                yield* replica.syncOnce;
                yield* replica.demand({
                    objectType: "Item",
                    query: {
                        where: eq(field("id"), "item-201"),
                        orderBy: [{ field: field("rank"), direction: "desc" }, { field: field("id") }],
                        limit: 1,
                    },
                });
                expect(installed).toEqual([
                    { name: "primaryKey", field: field("id"), unique: true },
                    { name: 'query:scalar:["rank"]', field: field("rank") },
                ]);
                decoded = 0;
                expect(
                    yield* replica.loadSubset("Item", { where: eq(field("id"), "item-201") })
                ).toMatchObject([{ key: "item-201", value: { id: "item-201", rank: 201 } }]);
                expect(decoded).toBe(1); // Existing PK index, not a full resident-row scan.
                const explicit = { name: "custom-id-index", field: field("id") };
                yield* replica.ensureIndex("Item", explicit);
                expect(installed.at(-1)).toEqual(explicit);
            })
        )
    );
});

test.each(["committed", "speculative"] as const)(
    "%s delivery capture translates bounded PK-ended ordering without changing raw session revisions",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const memory = yield* Memory.make();
                    const namespace = `capture-pk-${kind}`;
                    const baseName = JSON.stringify(["replica", namespace, "base:Item"]);
                    const orderedReads: Query[] = [];
                    const tables: TablesService = {
                        ...memory,
                        transaction: (body) =>
                            memory.transaction((tx) =>
                                body({
                                    ...tx,
                                    query: new Proxy(tx.query, {
                                        apply(target, receiver, args) {
                                            const request = args[0] as ReadTable<unknown>;
                                            const query = args[1] as Query | undefined;
                                            if (
                                                !("select" in request) &&
                                                request.name === baseName &&
                                                query?.orderBy?.length
                                            )
                                                orderedReads.push(query);
                                            return Reflect.apply(target, receiver, args);
                                        },
                                    }),
                                })
                            ),
                    };
                    const backend = yield* makeOwnedBackend({
                        namespace: "authority",
                        ir,
                        tables: yield* Memory.make(),
                        mutators: {},
                    });
                    const rows = Array.from({ length: 300 }, (_, n) => ({
                        id: `item-${String(n).padStart(4, "0")}`,
                        rank: n >> 2,
                    }));
                    yield* backend.storage.transaction((tx) =>
                        Effect.forEach(rows, (row) => tx.put("Item", row), { discard: true })
                    );
                    const replica = yield* makeReplica({
                        namespace,
                        ir,
                        tables,
                        backend,
                        execute: () => Effect.die("A delivery cannot execute an action."),
                        startSync: false,
                        live: false,
                    });
                    yield* replica.demand({ objectType: "Item" });
                    yield* replica.syncOnce;
                    const selection = {
                        actionIds: [],
                        subsets: [
                            {
                                objectType: "Item",
                                query: {
                                    orderBy: [
                                        {
                                            field: field("rank"),
                                            direction: "desc" as const,
                                            nulls: "first" as const,
                                        },
                                        { field: field("id"), nulls: "first" as const },
                                    ],
                                    limit: 51,
                                },
                            },
                        ],
                    };
                    const client = kind === "speculative" ? yield* replica.openClient() : undefined;
                    const delivery = client
                        ? yield* replica.subscribeClient(
                              { client: client.client, connectionId: client.connectionId },
                              { generation: 1, selection }
                          )
                        : yield* replica.subscribeSelection(selection);
                    const revision = (yield* replica.snapshotState).revision;
                    orderedReads.length = 0;
                    const first = yield* Stream.runHead(delivery.frames);
                    const frame = Option.getOrThrow(first);
                    expect(frame.end).toBe(true);
                    expect(
                        frame.changes
                            .filter((change) => change.kind === "put" && change.record.kind === "base")
                            .map((change) =>
                                change.kind === "put" && change.record.kind === "base"
                                    ? change.record.key
                                    : undefined
                            )
                    ).toEqual(
                        rows
                            .slice()
                            .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                            .slice(0, 51)
                            .map((row) => row.id)
                    );
                    expect(orderedReads.length).toBeGreaterThan(0);
                    expect(
                        orderedReads.every(
                            (query) =>
                                query.orderBy?.length === 1 && query.orderBy[0]!.field.path[0] === "rank"
                        )
                    ).toBe(true);
                    if (kind === "committed") expect((yield* replica.snapshotState).revision).toBe(revision);
                })
            ).pipe(Effect.timeout("5 seconds"))
        );
    }
);
