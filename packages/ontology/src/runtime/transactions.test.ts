import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq as storageEq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Query, eq, toArray } from "@tanstack/db";
import { Effect, Result } from "effect";
import { expect, test } from "vite-plus/test";
import { createReadTx } from "../live/mutators/createMutatorTx.js";
import { executeTransactionMutator, withTransactionCollections } from "./transactions.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Counter", "Audit"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: name,
        primaryKey: "id",
        properties: [
            { name: "id", displayName: "Id", type: o.string({}) },
            { name: "count", displayName: "Count", type: o.integer({}) },
        ],
    })),
    actionTypes: ["increment", "reject"].map((name) => ({
        name,
        displayName: name,
        logic: [],
        parameters: [],
    })),
};

test("mutator queries lazily read transaction-local persisted rows and earlier writes", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const mutators = {
                increment: (
                    tx: Parameters<typeof executeTransactionMutator>[0]["tx"],
                    action: { id: string; name: string }
                ) =>
                    executeTransactionMutator({
                        ir,
                        tx,
                        name: action.name,
                        parameters: {},
                        operationId: action.id,
                        mutators: {
                            increment: async ({ tx }) => {
                                const previous = await tx.query<{ count: number } | undefined>((q, objects) =>
                                    q
                                        .from({ c: objects.Counter! })
                                        .where(({ c }) => eq(c.id, "shared"))
                                        .findOne()
                                );
                                if (previous)
                                    await tx.mutate.Counter!.update("shared", { count: previous.count + 1 });
                                else await tx.mutate.Counter!.create({ id: "shared", count: 1 });
                                const own = await tx.query<{ count: number } | undefined>((q, objects) =>
                                    q
                                        .from({ c: objects.Counter! })
                                        .where(({ c }) => eq(c.id, "shared"))
                                        .findOne()
                                );
                                expect(own?.count).toBe((previous?.count ?? 0) + 1);
                                await tx.mutate.Audit!.create({ id: String(own!.count), count: own!.count });
                            },
                        },
                    }).pipe(Effect.asVoid),
                reject: (tx: Parameters<typeof executeTransactionMutator>[0]["tx"]) =>
                    executeTransactionMutator({
                        ir,
                        tx,
                        name: "reject",
                        parameters: {},
                        operationId: "reject",
                        mutators: {
                            reject: async ({ tx }) => {
                                await tx.mutate.Counter!.update("shared", { count: 999 });
                                throw new Error("Rejected after mutation");
                            },
                        },
                    }).pipe(Effect.asVoid),
            };
            const backend = yield* makeOwnedBackend({ namespace: "transaction-query", ir, tables, mutators });
            yield* Effect.all(
                Array.from({ length: 5 }, (_, index) =>
                    backend.applyAction({ id: String(index), name: "increment", parameters: {} })
                ),
                { concurrency: "unbounded" }
            );
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(5);
            expect((yield* backend.loadSubset({ objectType: "Audit" })).rows).toHaveLength(5);
            expect(
                Result.isFailure(
                    yield* Effect.result(
                        backend.applyAction({ id: "reject", name: "reject", parameters: {} })
                    )
                )
            ).toBe(true);
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(5);
        })
    );
});

test("action null clears optional properties while omitted inputs preserve existing values", async () => {
    const optional = o.optional({ type: o.string({}) });
    const assignments = [{ property: ["label"], value: o.Expression.inputReference({ name: "label" }) }];
    const nullableIR: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        objectTypes: [
            {
                name: "Note",
                displayName: "Note",
                pluralDisplayName: "Notes",
                primaryKey: "id",
                properties: [
                    { name: "id", displayName: "Id", type: o.string({}) },
                    { name: "label", displayName: "Label", type: optional },
                    { name: "payload", displayName: "Payload", type: o.unknown({}) },
                ],
            },
        ],
        actionTypes: [
            {
                name: "create",
                displayName: "Create",
                parameters: [
                    { name: "id", displayName: "Id", type: o.string({}) },
                    { name: "label", displayName: "Label", type: optional },
                ],
                logic: [
                    o.ActionLogicStep.createObject({
                        objectType: "Note",
                        values: [
                            { property: ["id"], value: o.Expression.inputReference({ name: "id" }) },
                            ...assignments,
                            { property: ["payload"], value: o.Expression.literal({ value: null }) },
                        ],
                    }),
                ],
            },
            {
                name: "update",
                displayName: "Update",
                parameters: [
                    { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
                    { name: "label", displayName: "Label", type: optional },
                ],
                logic: [o.ActionLogicStep.updateObject({ object: { name: "note" }, values: assignments })],
            },
        ],
    };
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const execute = (
                tx: Parameters<typeof executeTransactionMutator>[0]["tx"],
                invocation: { id: string; name: string; parameters: Record<string, unknown> }
            ) =>
                executeTransactionMutator({
                    ir: nullableIR,
                    tx,
                    name: invocation.name,
                    operationId: invocation.id,
                    parameters: invocation.parameters,
                }).pipe(Effect.asVoid);
            const backend = yield* makeOwnedBackend({
                namespace: "null-clear",
                ir: nullableIR,
                tables,
                mutators: { create: execute, update: execute },
            });
            yield* backend.applyAction({
                id: "create",
                name: "create",
                parameters: { id: "one", label: null },
            });
            expect((yield* backend.loadSubset({ objectType: "Note" })).rows[0]?.value).toEqual({
                id: "one",
                label: undefined,
                payload: null,
            });
            yield* backend.applyAction({
                id: "set",
                name: "update",
                parameters: { note: "one", label: "Present" },
            });
            yield* backend.applyAction({ id: "omit", name: "update", parameters: { note: "one" } });
            expect((yield* backend.loadSubset({ objectType: "Note" })).rows[0]?.value.label).toBe("Present");
            yield* backend.applyAction({
                id: "clear",
                name: "update",
                parameters: { note: "one", label: null },
            });
            expect((yield* backend.loadSubset({ objectType: "Note" })).rows[0]?.value.label).toBeUndefined();
        })
    );
});

test("transaction query preparation narrows repeated point queries and keyed mutations instead of loading a type", async () => {
    const calls: unknown[] = [];
    const rows = ["one", "two"].map((id, index) => ({ key: id, value: { id, count: index + 1 } }));
    const tx = {
        get: (_type: string, key: string | number) =>
            Effect.sync(() => {
                calls.push(key);
                return rows.find((row) => row.key === key)?.value;
            }),
        loadSubset: (_type: string, query?: import("@party-stack/ontology-storage").Query) =>
            Effect.sync(() => {
                expect(query?.where).toBeDefined();
                calls.push(query);
                return evaluateQuery(rows, query);
            }),
        put: () => Effect.void,
        delete: () => Effect.void,
    };
    await Effect.runPromise(
        executeTransactionMutator({
            ir,
            tx,
            name: "increment",
            parameters: {},
            operationId: "precise",
            mutators: {
                increment: async ({ tx }) => {
                    for (const id of ["one", "two", "one"]) {
                        const row = await tx.query<{ count: number }>((q, objects) =>
                            q
                                .from({ row: objects.Counter! })
                                .where(({ row }) => eq(row.id, id))
                                .findOne()
                        );
                        expect(row.count).toBe(id === "one" ? 1 : 2);
                    }
                    await tx.mutate.Counter!.update("one", { count: 3 });
                    await tx.mutate.Audit!.create({ id: "new", count: 3 });
                },
            },
        })
    );
    expect(calls).toEqual([
        { where: storageEq(field("id"), "one") },
        { where: storageEq(field("id"), "two") },
        "one",
        "new",
    ]);
});

test("transaction queries prepare only referenced sources and keep repeated reads in one snapshot", async () => {
    const loaded: string[] = [];
    const read = {
        get: () => Effect.succeed(undefined),
        loadSubset: (type: string) =>
            Effect.sync(() => {
                loaded.push(type);
                if (type !== "Counter") throw new Error("Unreferenced source loaded");
                return [{ key: "one", value: { id: "one", count: 1 } }];
            }),
    };
    await Effect.runPromise(withTransactionCollections(ir, read, () => Effect.void));
    expect(loaded).toEqual([]);
    await Effect.runPromise(
        withTransactionCollections(ir, read, (objects, ensureLoaded) =>
            Effect.promise(async () => {
                const tx = createReadTx(objects, ensureLoaded);
                for (const _ of [1, 2]) {
                    void _;
                    const rows = await tx.query<{ count: number }[]>((q, objects) =>
                        q
                            .from({ counter: objects.Counter! })
                            .select(({ counter }) => ({ count: counter.count }))
                    );
                    expect(rows.map((row) => row.count)).toEqual([1]);
                }
            })
        )
    );
    expect(loaded).toEqual(["Counter"]);
});

test("transaction joins and limited includes load persisted subsets through TanStack demand", async () => {
    const calls: { type: string; query?: import("@party-stack/ontology-storage").Query }[] = [];
    const rows = {
        Counter: [
            { key: "one", value: { id: "one", count: 1 } },
            { key: "two", value: { id: "two", count: 2 } },
            { key: "unrelated", value: { id: "unrelated", count: 3 } },
        ],
        Audit: [
            { key: "audit-one", value: { id: "audit-one", count: 1 } },
            { key: "audit-two", value: { id: "audit-two", count: 1 } },
            { key: "audit-three", value: { id: "audit-three", count: 2 } },
            { key: "audit-four", value: { id: "audit-four", count: 2 } },
            { key: "unrelated", value: { id: "unrelated", count: 3 } },
        ],
    };
    const read = {
        get: () => Effect.succeed(undefined),
        loadSubset: (type: string, query?: import("@party-stack/ontology-storage").Query) =>
            Effect.sync(() => {
                calls.push({ type, query });
                return evaluateQuery(rows[type as keyof typeof rows], query);
            }),
    };
    await Effect.runPromise(
        withTransactionCollections(ir, read, (objects, ensureLoaded) =>
            Effect.promise(async () => {
                const tx = createReadTx(objects, ensureLoaded);
                const joined = await tx.query<{ id: string; audit: string }[]>((q, objects) =>
                    q
                        .from({ counter: objects.Counter! })
                        .where(({ counter }) => eq(counter.id, "one"))
                        .leftJoin({ audit: objects.Audit! }, ({ counter, audit }) =>
                            eq(counter.count, audit.count)
                        )
                        .select(({ counter, audit }) => ({ id: counter.id, audit: audit?.id }))
                );
                expect(joined).toMatchObject([
                    { id: "one", audit: "audit-one" },
                    { id: "one", audit: "audit-two" },
                ]);
                const included = await tx.query<{ id: string; audits: { count: number }[] }[]>((q, objects) =>
                    q
                        .from({ counter: objects.Counter! })
                        .where(({ counter }) => eq(counter.id, "two"))
                        .select(({ counter }) => ({
                            id: counter.id,
                            audits: toArray(
                                new Query()
                                    .from({ audit: objects.Audit! })
                                    .where(({ audit }) => eq(audit.count, counter.count))
                                    .orderBy(({ audit }) => audit.count, "desc")
                                    .limit(1)
                                    .select(({ audit }) => ({ count: audit.count }))
                            ),
                        }))
                );
                expect(included).toMatchObject([{ id: "two", audits: [{ count: 2 }] }]);
            })
        )
    );
    expect(calls.filter(({ type }) => type === "Counter").every(({ query }) => query?.where)).toBe(true);
    const childCalls = calls.filter(({ type }) => type === "Audit");
    expect(childCalls.length).toBeGreaterThan(0);
    expect(
        childCalls.every(({ query }) => query?.where),
        JSON.stringify(calls)
    ).toBe(true);
});
