import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { DeliveryFrame } from "@party-stack/ontology-backend/delivery";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Row",
            displayName: "Row",
            pluralDisplayName: "Rows",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "write",
            displayName: "Write",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
            logic: [],
        },
        {
            name: "remove",
            displayName: "Remove",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            logic: [],
        },
    ],
};
const execute = (tx: OwnedTransaction, request: ActionRequest) =>
    request.name === "remove"
        ? tx.delete("Row", String(request.parameters.id))
        : tx.put("Row", { id: request.parameters.id, title: request.parameters.title });

test.each(["committed", "speculative"] as const)(
    "%s query-membership patches replace coverage while retaining unrelated cached rows",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const authority = yield* makeOwnedBackend({
                        namespace: `membership-authority-${kind}`,
                        ir,
                        tables: yield* Memory.make(),
                        mutators: { write: execute, remove: execute },
                    });
                    for (const id of ["a", "b"])
                        yield* authority.applyAction({
                            id: `seed-${id}`,
                            name: "write",
                            parameters: { id, title: id },
                        });
                    const parent =
                        kind === "speculative"
                            ? yield* makeReplica({
                                  namespace: "membership-parent",
                                  ir,
                                  tables: yield* Memory.make(),
                                  backend: authority,
                                  execute,
                                  startSync: false,
                                  objectCacheGc: false,
                              })
                            : undefined;
                    if (parent) {
                        yield* parent.demand({ objectType: "Row" });
                        yield* parent.syncOnce;
                    }
                    const source = parent ? replicaStateSource(parent) : undefined;
                    const tables = yield* Memory.make();
                    const child = yield* makeReplica({
                        namespace: `membership-child-${kind}`,
                        ir,
                        tables,
                        ...(source ? { source } : { backend: authority }),
                        execute,
                        startSync: false,
                        objectCacheGc: false,
                    });
                    const transfer = Effect.fnUntraced(function* () {
                        return yield* Effect.scoped(
                            Effect.gen(function* () {
                                const opened = yield* child.openParentDelivery(source);
                                const pull = yield* Stream.toPull(opened.subscription.frames);
                                let frames: DeliveryFrame[] = [];
                                for (;;) {
                                    for (const frame of yield* pull) {
                                        frames.push(frame);
                                        const installed = yield* child.receiveDelivery(
                                            frame,
                                            opened.generation
                                        );
                                        if (!installed) continue;
                                        if (source && installed.metadata.client)
                                            yield* source.acknowledge(
                                                opened.session ?? installed.metadata.client,
                                                installed.metadata.revision,
                                                installed.metadata.client.deliveredThrough,
                                                installed.metadata.generation
                                            );
                                        yield* opened.subscription.acknowledge(installed.position);
                                        // A reconnect can replay its last installed batch before
                                        // capturing newer changes. Install/ACK it as a real client
                                        // does, then inspect the next newly applied batch.
                                        if (installed.duplicate) frames = [];
                                        else return frames;
                                    }
                                }
                            })
                        );
                    });
                    const a = { objectType: "Row", query: { where: eq(field("id"), "a") } };
                    const b = { objectType: "Row", query: { where: eq(field("id"), "b") } };
                    const aScope = yield* Scope.fork(yield* Effect.scope);
                    yield* Scope.provide(child.demand(a), aScope);
                    const first = yield* transfer();
                    expect(first[0]?.kind).toBe("snapshot");
                    expect((yield* child.confirmed.get("Row", "a"))?.title).toBe("a");
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, a))).toBe(true);

                    yield* Scope.close(aScope, Exit.void);
                    const bScope = yield* Scope.fork(yield* Effect.scope);
                    yield* Scope.provide(child.demand(b), bScope);
                    const second = yield* transfer();
                    expect(second[0]).toMatchObject({ streamId: first[0]!.streamId, kind: "patch" });
                    expect(second.flatMap((frame) => frame.changes)).toEqual(
                        expect.arrayContaining([
                            { kind: "remove", ref: { kind: "base", objectType: "Row", key: "a" } },
                            {
                                kind: "put",
                                record: {
                                    kind: "base",
                                    objectType: "Row",
                                    key: "b",
                                    value: { id: "b", title: "b" },
                                },
                            },
                        ])
                    );
                    if (kind === "committed") {
                        expect(first.at(-1)?.metadata?.generation).toBe(1);
                        expect(second.at(-1)?.metadata?.generation).toBe(1);
                    }
                    expect((yield* child.confirmed.get("Row", "a"))?.title).toBe("a");
                    expect((yield* child.loadSubset("Row", b.query)).map((row) => row.key)).toEqual(["b"]);
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, a))).toBe(false);
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, b))).toBe(true);
                    const coverage = yield* tables.query(
                        Table.make({
                            name: JSON.stringify(["replica", `membership-child-${kind}`, "coverage"]),
                        })
                    );
                    expect(coverage).toHaveLength(1);
                    expect(coverage[0]?.value).toMatchObject({ subset: b, complete: true });

                    // A remains cached but is no longer selected. Its deletion is not
                    // part of B's record membership, so B's delta cannot remove it.
                    yield* authority.applyAction({
                        id: "delete-a-outside-view",
                        name: "remove",
                        parameters: { id: "a" },
                    });
                    yield* authority.applyAction({ id: "delete-b", name: "remove", parameters: { id: "b" } });
                    if (parent) yield* parent.syncOnce;
                    const third = yield* transfer();
                    expect(third[0]).toMatchObject({ streamId: second[0]!.streamId, kind: "patch" });
                    expect(third.flatMap((frame) => frame.changes)).toContainEqual({
                        kind: "remove",
                        ref: { kind: "base", objectType: "Row", key: "b" },
                    });
                    expect(yield* child.confirmed.get("Row", "b")).toBeUndefined();
                    expect((yield* child.confirmed.get("Row", "a"))?.title).toBe("a");
                    expect(yield* child.loadSubset("Row", b.query)).toEqual([]);
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, b))).toBe(true);

                    yield* Scope.close(bScope, Exit.void);
                    yield* child.demand(a);
                    const fourth = yield* transfer();
                    expect(fourth[0]).toMatchObject({ streamId: third[0]!.streamId, kind: "patch" });
                    // Both producer memberships are empty. The newly complete A
                    // selection must still repair the stale cached A row.
                    expect(fourth.flatMap((frame) => frame.changes)).toEqual([]);
                    expect(yield* child.confirmed.get("Row", "a")).toBeUndefined();
                    expect(yield* child.loadSubset("Row", a.query)).toEqual([]);
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, a))).toBe(true);
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, b))).toBe(false);
                })
            )
        );
    }
);

test.each([
    ["committed", "gc"],
    ["speculative", "gc"],
    ["committed", "legacy"],
    ["speculative", "legacy"],
] as const)("%s delivery rebuilds its snapshot after %s membership loss", async (kind, invalidation) => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* makeOwnedBackend({
                    namespace: `residency-authority-${kind}-${invalidation}`,
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { write: execute, remove: execute },
                });
                yield* authority.applyAction({
                    id: "seed-a",
                    name: "write",
                    parameters: { id: "a", title: "a" },
                });
                const parent =
                    kind === "speculative"
                        ? yield* makeReplica({
                              namespace: `residency-parent-${invalidation}`,
                              ir,
                              tables: yield* Memory.make(),
                              backend: authority,
                              execute,
                              startSync: false,
                              objectCacheGc: false,
                          })
                        : undefined;
                if (parent) {
                    yield* parent.demand({ objectType: "Row" });
                    yield* parent.syncOnce;
                }
                const source = parent ? replicaStateSource(parent) : undefined;
                const tables = yield* Memory.make();
                const namespace = `residency-child-${kind}-${invalidation}`;
                const child = yield* makeReplica({
                    namespace,
                    ir,
                    tables,
                    ...(source ? { source } : { backend: authority }),
                    execute,
                    startSync: false,
                    objectCacheGc: false,
                });
                const transfer = Effect.fnUntraced(function* () {
                    return yield* Effect.scoped(
                        Effect.gen(function* () {
                            const opened = yield* child.openParentDelivery(source);
                            const pull = yield* Stream.toPull(opened.subscription.frames);
                            let frames: DeliveryFrame[] = [];
                            for (;;) {
                                for (const frame of yield* pull) {
                                    frames.push(frame);
                                    const installed = yield* child.receiveDelivery(frame, opened.generation);
                                    if (!installed) continue;
                                    if (source && installed.metadata.client)
                                        yield* source.acknowledge(
                                            opened.session ?? installed.metadata.client,
                                            installed.metadata.revision,
                                            installed.metadata.client.deliveredThrough,
                                            installed.metadata.generation
                                        );
                                    yield* opened.subscription.acknowledge(installed.position);
                                    if (installed.duplicate) frames = [];
                                    else return frames;
                                }
                            }
                        })
                    );
                });
                const a = { objectType: "Row", query: { where: eq(field("id"), "a") } };
                const demand = yield* Scope.fork(yield* Effect.scope);
                yield* Scope.provide(child.demand(a), demand);
                const first = yield* transfer();
                expect(first[0]?.kind).toBe("snapshot");
                expect((yield* child.confirmed.get("Row", "a"))?.title).toBe("a");
                expect(yield* child.collectGarbage({ minUnusedAgeMs: 0, maxCandidates: 10 })).toBe(0);
                const generation = yield* child.parentDeliveryGeneration;
                yield* Scope.close(demand, Exit.void);
                const position = Table.make<Record<string, unknown>>({
                    name: JSON.stringify(["replica", namespace, "position"]),
                });
                if (invalidation === "gc") {
                    expect(yield* child.collectGarbage({ minUnusedAgeMs: 0, maxCandidates: 10 })).toBe(1);
                    expect(yield* child.confirmed.get("Row", "a")).toBeUndefined();
                    expect(yield* tables.read((tx) => child.hasCoverage(tx, a))).toBe(false);
                    expect((yield* tables.get(position, "head"))?.deliveryResident).toBe(false);
                } else {
                    // Simulate persisted metadata from before installed-membership
                    // tracking existed. Keep its real receiver position and cached row.
                    yield* tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const head = { ...(yield* tx.get(position, "head"))! };
                            delete head.deliveryMembershipVersion;
                            delete head.deliveryResident;
                            yield* tx.put(position, "head", head);
                        })
                    );
                }
                yield* child.demand(a);
                if (invalidation === "gc")
                    expect(yield* child.parentDeliveryGeneration).toBeGreaterThan(generation);
                const second = yield* transfer();
                expect(second[0]?.kind).toBe("snapshot");
                expect(second[0]?.streamId).not.toBe(first[0]?.streamId);
                expect(second.flatMap((frame) => frame.changes)).toContainEqual({
                    kind: "put",
                    record: { kind: "base", objectType: "Row", key: "a", value: { id: "a", title: "a" } },
                });
                expect((yield* child.confirmed.get("Row", "a"))?.title).toBe("a");
                expect(yield* tables.read((tx) => child.hasCoverage(tx, a))).toBe(true);
                expect(yield* tables.get(position, "head")).toMatchObject({
                    deliveryMembershipVersion: 1,
                    deliveryResident: true,
                });
            })
        )
    );
});
