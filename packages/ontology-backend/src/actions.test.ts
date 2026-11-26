import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Cause, Fiber } from "effect";
import { describe, expect, it, vi, test } from "vite-plus/test";
import { executeAction } from "./actions.js";
import { makeOwnedBackend } from "./owned.js";
import { objectSubset } from "./subset.js";

describe("executeAction", () => {
    it("assigns stable temporary string keys to optimistic creates", async () => {
        const create = vi.fn((_value: Record<string, unknown>) => Promise.resolve());
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "Id",
                    properties: [
                        {
                            name: "Id",
                            displayName: "ID",
                            type: o.string({}),
                        },
                        {
                            name: "Subject",
                            displayName: "Subject",
                            type: o.string({}),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createTask",
                    displayName: "Create Task",
                    parameters: [
                        {
                            name: "Subject",
                            displayName: "Subject",
                            type: o.string({}),
                        },
                    ],
                    logic: [
                        {
                            kind: "createObject",
                            value: {
                                objectType: "Task",
                                values: [
                                    {
                                        property: ["Subject"],
                                        value: {
                                            kind: "inputReference",
                                            value: {
                                                name: "Subject",
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
            queryFunctionTypes: [],
        };

        await Effect.runPromise(
            executeAction({
                ir,
                request: { id: "request-1", name: "createTask", parameters: { Subject: "Follow up" } },
                tx: {
                    get: () => Effect.succeed(undefined),
                    loadSubset: () => Effect.succeed([]),
                    put: (_type, value) => Effect.promise(() => create(value)),
                    patch: () => Effect.void,
                    delete: () => Effect.void,
                },
            })
        );

        expect(create).toHaveBeenCalledWith({
            Id: "optimistic:request-1:Task:0",
            Subject: "Follow up",
        });
    });
});

test.each(["defect", "interrupt"] as const)(
    "native action %s preserves rollback and the correct error channel",
    async (mode) => {
        const ir: OntologyIR = {
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
                    properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
                },
            ],
        };
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* makeOwnedBackend({
                        ir,
                        namespace: "native-errors",
                        tables: yield* Memory.make(),
                        mutators: {
                            write: (tx, request) =>
                                executeAction({
                                    ir,
                                    tx,
                                    request,
                                    mutators: {
                                        write: (tx) =>
                                            tx
                                                .put("Item", { id: "one" })
                                                .pipe(
                                                    Effect.andThen(
                                                        mode === "defect"
                                                            ? Effect.die("private implementation failure")
                                                            : Effect.interrupt
                                                    )
                                                ),
                                    },
                                }).pipe(Effect.asVoid),
                        },
                    });
                    if (mode === "defect") {
                        const result = yield* Effect.result(
                            backend.applyAction({ id: "write", name: "write", parameters: {} })
                        );
                        expect(result).toMatchObject({
                            _tag: "Failure",
                            failure: { kind: "Internal", message: "Action execution failed." },
                        });
                    } else {
                        const fiber = yield* Effect.forkChild(
                            backend.applyAction({ id: "write", name: "write", parameters: {} })
                        );
                        const exit = yield* Fiber.await(fiber);
                        expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
                    }
                    expect((yield* backend.loadSubset(objectSubset("Item"))).rows).toEqual([]);
                    expect((yield* backend.changes!.pull({})).commits).toEqual([]);
                })
            )
        );
    }
);

test("native mutators query their transaction through Query IR and see preceding writes", async () => {
    const ir: OntologyIR = {
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
                properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
            },
        ],
    };
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "native-query",
                    tables: yield* Memory.make(),
                    mutators: {
                        write: (tx, request) =>
                            executeAction({
                                ir,
                                tx,
                                request,
                                mutators: {
                                    write: (tx) =>
                                        Effect.gen(function* () {
                                            yield* tx.put("Item", { id: "one" });
                                            const value = yield* tx.query({
                                                select: [
                                                    q.sub("items", {
                                                        from: {
                                                            source: { objectType: "Item" },
                                                            binding: "item",
                                                        },
                                                        select: [q.selectField("id", q.field("item", "id"))],
                                                    }),
                                                ],
                                            });
                                            expect(value.items).toEqual([{ id: "one" }]);
                                        }),
                                },
                            }).pipe(Effect.asVoid),
                    },
                });
                yield* backend.applyAction({ id: "write", name: "write", parameters: {} });
            })
        )
    );
});

test("applies delete and update steps to each object of a list target", async () => {
    const deleted: unknown[] = [];
    const patched: unknown[] = [];
    const task = o.objectReference({ objectType: "Task" });
    const ir: OntologyIR = {
        types: [],
        objectTypes: [
            {
                name: "Task",
                displayName: "Task",
                pluralDisplayName: "Tasks",
                primaryKey: "Id",
                properties: [
                    { name: "Id", displayName: "ID", type: o.string({}) },
                    { name: "Done", displayName: "Done", type: o.boolean({}) },
                ],
            },
        ],
        linkTypes: [],
        actionTypes: [
            {
                name: "deleteTasks",
                displayName: "Delete Tasks",
                parameters: [{ name: "tasks", displayName: "Tasks", type: o.list({ elementType: task }) }],
                logic: [o.ActionLogicStep.deleteObject({ object: { name: "tasks" } })],
            },
            {
                name: "completeTasks",
                displayName: "Complete Tasks",
                parameters: [{ name: "tasks", displayName: "Tasks", type: o.list({ elementType: task }) }],
                logic: [
                    o.ActionLogicStep.updateObject({
                        object: { name: "tasks" },
                        values: [{ property: ["Done"], value: o.Expression.literal({ value: true }) }],
                    }),
                ],
            },
        ],
        queryFunctionTypes: [],
    };
    const tx = {
        get: () => Effect.succeed(undefined),
        loadSubset: () => Effect.succeed([]),
        put: () => Effect.void,
        patch: (type: string, key: unknown, changes: unknown) =>
            Effect.sync(() => void patched.push([type, key, changes])),
        delete: (type: string, key: unknown) => Effect.sync(() => void deleted.push([type, key])),
    };

    await Effect.runPromise(
        executeAction({
            ir,
            request: { id: "r1", name: "deleteTasks", parameters: { tasks: ["a", "b"] } },
            tx,
        })
    );
    await Effect.runPromise(
        executeAction({
            ir,
            request: { id: "r2", name: "completeTasks", parameters: { tasks: ["c"] } },
            tx,
        })
    );

    expect(deleted).toEqual([
        ["Task", "a"],
        ["Task", "b"],
    ]);
    expect(patched).toEqual([["Task", "c", [{ path: ["Done"], value: true }]]]);
});
