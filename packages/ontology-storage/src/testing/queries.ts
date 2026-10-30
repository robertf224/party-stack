import { o, type OntologyIR, type QueryDocument, type TypeDef } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { Effect, Result } from "effect";
import { Table } from "../model.js";
import { makeStorageModel } from "../ontology/model.js";
import { makeOntologyStorage } from "../ontology/storage.js";
import type { ReadStorageTransaction } from "../ontology/storage.js";
import type { ReadTransaction } from "../tables.js";
import type { TablesService } from "../tables.js";

const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error(message);
};
const property = (name: string, type: TypeDef = o.string({})) => ({ name, displayName: name, type });
const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    queryFunctionTypes: [],
    linkTypes: [],
    context: { type: o.struct({ fields: [property("viewer")] }) },
    objectTypes: [
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [property("id"), property("name")],
        },
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [property("id"), property("owner"), property("rank", o.integer({}))],
        },
    ],
};
const taskQuery = {
    from: { source: { objectType: "Task" }, binding: "t" },
    where: q.and(
        q.eq(q.field("t", "owner"), q.field("u", "id")),
        q.gt(q.field("t", "rank"), q.input("floor"))
    ),
    orderBy: [{ expression: q.field("t", "rank"), direction: "desc" as const }],
    page: { limit: 1 },
    select: [
        q.selectField("id", q.field("t", "id")),
        q.selectField("score", q.add(q.field("t", "rank"), q.literal(100))),
    ],
};
const document: QueryDocument = {
    inputs: [property("floor", o.integer({}))],
    select: [
        q.selectField("viewer", q.context("viewer")),
        q.sub("users", {
            from: { source: { objectType: "User" }, binding: "u" },
            orderBy: [{ expression: q.field("u", "id") }],
            select: [
                q.selectField("name", q.field("u", "name")),
                q.sub("latest", taskQuery),
                q.selectField("hasTasks", q.exists(taskQuery)),
            ],
        }),
        q.sub("top", {
            ...taskQuery,
            where: q.gt(q.field("t", "rank"), q.input("floor")),
            page: { after: { values: [3], key: "three" }, limit: 1 },
        }),
        q.selectCase({
            branches: [
                {
                    condition: q.eq(q.context("viewer"), q.literal("viewer")),
                    select: [q.selectField("message", q.literal("visible"))],
                },
            ],
            else: [q.selectField("message", q.literal("other"))],
        }),
    ],
};

/** Same full Query IR on schema-free tables and ontology objects, on every driver. */
export const runQueryContract = Effect.fnUntraced(function* (tables: TablesService) {
    const users = Table.make<{ id: string; name: string }>({ name: "query-contract-users" });
    const tasks = Table.make<{ id: string; owner: string; rank: number }>({ name: "query-contract-tasks" });
    const sources = { User: users, Task: tasks };
    const options = { inputs: { floor: 0 }, context: { viewer: "viewer" } };
    const data = {
        users: [
            { id: "a", name: "Alice" },
            { id: "b", name: "Bob" },
        ],
        tasks: [
            { id: "one", owner: "a", rank: 1 },
            { id: "two", owner: "a", rank: 2 },
            { id: "three", owner: "a", rank: 3 },
        ],
    };
    const model = yield* makeStorageModel({ namespace: "query-contract", ir });
    const storage = makeOntologyStorage(model, tables);
    yield* storage.transaction((tx) =>
        Effect.gen(function* () {
            for (const user of data.users) {
                yield* tx.put(model.objects.User!, user);
                yield* tables.put(users, user.id, user);
            }
            for (const task of data.tasks) {
                yield* tx.put(model.objects.Task!, task);
                yield* tables.put(tasks, task.id, task);
            }
        })
    );
    const expected = {
        viewer: "viewer",
        users: [
            { name: "Alice", latest: [{ id: "three", score: 103 }], hasTasks: true },
            { name: "Bob", latest: [], hasTasks: false },
        ],
        top: [{ id: "two", score: 102 }],
        message: "visible",
    };
    const raw = yield* tables.query(document, { sources, ...options });
    const objects = yield* storage.query(document, options);
    assert(
        JSON.stringify(raw) === JSON.stringify(expected),
        "Raw table hierarchical query, correlation, cursor or projection failed"
    );
    assert(
        JSON.stringify(objects) === JSON.stringify(expected),
        "Ontology query must use the same Query IR evaluator"
    );
    for (const kind of ["raw", "ontology"] as const) {
        const rejected = yield* Effect.result(
            kind === "raw"
                ? tables.query(document, { sources, ...options, inputs: { floor: "invalid" } })
                : storage.query(document, { ...options, inputs: { floor: "invalid" } })
        );
        assert(
            Result.isFailure(rejected) && rejected.failure.reason._tag === "QueryError",
            "Invalid query input must be a typed failure"
        );
    }
    const rollback = yield* Effect.result(
        storage.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.put(model.objects.User!, { id: "c", name: "Carol" });
                const result = yield* storage.query(document, options);
                assert(
                    (result.users as unknown[]).length === 3,
                    "Service-level query must reuse the active object transaction"
                );
                return yield* Effect.fail("rollback");
            })
        )
    );
    assert(Result.isFailure(rollback), "Expected query transaction rollback");
    assert(
        (yield* storage.get(model.objects.User!, "c")) === undefined,
        "Query must not open a separate committing transaction"
    );
    const invalid: QueryDocument = {
        select: [q.sub("unknown", { from: { source: { objectType: "Unknown" }, binding: "x" }, select: [] })],
    };
    const missing = yield* tables.query(invalid, { sources }).pipe(Effect.result);
    assert(
        Result.isFailure(missing) && missing.failure.reason._tag === "QueryError",
        "Unknown raw table bindings must fail explicitly"
    );
    const related: QueryDocument = {
        select: [
            q.sub("users", {
                from: { source: { objectType: "User" }, binding: "u" },
                select: [q.selectField("tasks", o.Expression.related({ source: q.row("u"), link: "tasks" }))],
            }),
        ],
    };
    const unsupported = yield* tables.query(related, { sources }).pipe(Effect.result);
    assert(
        Result.isFailure(unsupported) && unsupported.failure.reason._tag === "QueryError",
        "Raw tables must reject relationship shorthand without metadata"
    );
    let escapedRaw: ReadTransaction | undefined;
    let escapedObjects: ReadStorageTransaction | undefined;
    yield* tables.read((tx) =>
        Effect.sync(() => {
            escapedRaw = tx;
        })
    );
    yield* storage.read((tx) =>
        Effect.sync(() => {
            escapedObjects = tx;
        })
    );
    const literal: QueryDocument = { select: [q.selectField("answer", q.literal(42))] };
    for (const operation of [escapedRaw!.query(literal, { sources: {} }), escapedObjects!.query(literal)]) {
        const closed = yield* operation.pipe(Effect.result);
        assert(
            Result.isFailure(closed) && closed.failure.reason._tag === "TransactionError",
            "Literal-only queries must reject closed transaction handles too"
        );
    }
});
