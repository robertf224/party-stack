import { defineOntology, o, type OntologyIR } from "@party-stack/ontology-spec";
import { Result as ResultCodec, TemporalTimestamp } from "@party-stack/ontology-spec/effect";
import { Effect, Result, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import {
    makeOntologyStorage,
    makeStorageModel,
    contains,
    eq,
    field,
    type StorageTransaction,
} from "../index.js";
import { runQueryContract } from "./queries.js";
import type { TablesService } from "../tables.js";

const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error(message);
};
const User = Schema.Struct({ id: Schema.String, name: Schema.String });
const Task = Schema.Struct({
    id: Schema.Number.check(Schema.isInt32()),
    owner: Schema.String,
    rank: Schema.Number.check(Schema.isInt32()),
    tags: Schema.Array(Schema.String),
    outcome: ResultCodec(Schema.String, Schema.String),
    updated: TemporalTimestamp,
    thumbnail: Schema.optional(Schema.Struct({ id: Schema.String, type: Schema.optional(Schema.String) })),
});
const ir = defineOntology({
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "name", displayName: "Name", type: o.string({}) },
            ],
        },
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.integer({}) },
                { name: "owner", displayName: "Owner", type: o.objectReference({ objectType: "User" }) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
                { name: "tags", displayName: "Tags", type: o.list({ elementType: o.string({}) }) },
                {
                    name: "outcome",
                    displayName: "Outcome",
                    type: o.result({ okType: o.string({}), errType: o.string({}) }),
                },
                { name: "updated", displayName: "Updated", type: o.timestamp({}) },
                { name: "thumbnail", displayName: "Thumbnail", type: o.optional({ type: o.attachment({}) }) },
            ],
        },
    ],
});
const schemas = { User, Task };

export const runOntologyContract = Effect.fnUntraced(function* (tables: TablesService) {
    yield* runQueryContract(tables);
    const model = yield* makeStorageModel({ namespace: "ontology_contract", ir, schemas });
    const storage = makeOntologyStorage(model, tables);
    const { User: users, Task: tasks } = model.objects;
    const updated = Temporal.Instant.from("2026-10-19T12:34:56.123456789Z");
    const task = {
        id: 1,
        owner: "user",
        rank: 1,
        tags: ["urgent"],
        outcome: Result.succeed("done"),
        updated,
        thumbnail: { id: "image", type: "image/png" },
    };
    const errorReason = <A>(effect: Effect.Effect<A, unknown>, reason: string) =>
        Effect.gen(function* () {
            const result = yield* Effect.result(effect);
            assert(
                Result.isFailure(result) &&
                    typeof result.failure === "object" &&
                    result.failure !== null &&
                    "reason" in result.failure &&
                    (result.failure.reason as { _tag: string })._tag === reason,
                `Expected ${reason}.`
            );
        });
    yield* storage.transaction(() =>
        Effect.gen(function* () {
            yield* storage.put(users, { id: "user", name: "Owner" });
            yield* storage.put(tasks, task);
            yield* storage.ensureIndex(tasks, { name: "rank", field: field("rank"), unique: true });
            yield* storage.ensureIndex(tasks, { name: "tags", field: field("tags"), multiEntry: true });
            yield* storage.ensureIndex(tasks, { name: "outcome", field: field("outcome", "kind") });
        })
    );
    const loaded = yield* storage.get(tasks, 1);
    assert(
        (yield* storage.query(tasks, { where: contains(field("tags"), "urgent") }))
            .map((row) => row.key)
            .join() === "1",
        "Declared list fields support membership and element indexes"
    );
    assert(
        loaded?.id === 1 && loaded.updated.epochNanoseconds === updated.epochNanoseconds,
        "Primary-key derivation or Temporal precision failed."
    );
    assert(
        loaded && Result.isSuccess(loaded.outcome) && loaded.outcome.success === "done",
        "Effect Result did not round-trip."
    );
    assert(loaded?.thumbnail?.id === "image", "Attachment handles did not round-trip.");
    const runtimeModel = yield* makeStorageModel({ namespace: model.namespace, ir });
    const runtimeStorage = makeOntologyStorage(runtimeModel, tables);
    const runtimeTask = yield* runtimeStorage.get(runtimeModel.objects.Task!, 1);
    assert(
        runtimeTask && Result.isSuccess(runtimeTask.outcome as Result.Result<string, string>),
        "Runtime-derived codecs could not read the generated-codec namespace."
    );
    yield* runtimeStorage.put(runtimeModel.objects.Task!, { ...task, rank: 2 });
    assert(
        (yield* storage.get(tasks, 1))?.rank === 2,
        "Generated codecs could not read runtime-codec writes."
    );
    yield* storage.put(tasks, task);
    const subset = yield* storage.query(tasks, {
        where: eq(field("outcome", "kind"), "ok"),
        orderBy: [{ field: field("rank") }],
        limit: 2,
    });
    assert(
        subset.length === 1 && subset[0]?.key === 1,
        "Queries must use portable ontology paths, including Result tags."
    );
    yield* errorReason(
        storage.ensureIndex(tasks, { name: "missing", field: field("missing") }),
        "QueryError"
    );
    yield* errorReason(storage.query(tasks, { where: eq(field("missing"), 1) }), "QueryError");
    yield* errorReason(
        storage.query(tasks, { where: eq(field("outcome", "_tag"), "Success") }),
        "QueryError"
    );
    yield* errorReason(storage.put(tasks, { ...task, rank: 1.5 }), "CodecError");
    yield* errorReason(storage.put(tasks, { ...task, id: 2 }), "UniqueConstraint");
    yield* errorReason(storage.get(tasks, "1" as unknown as number), "QueryError");
    const rolledBack = yield* Effect.result(
        storage.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.put(users, { id: "rollback", name: "Rollback" });
                yield* tx.put(tasks, { ...task, id: 3, rank: 3 });
                return yield* Effect.fail("rollback");
            })
        )
    );
    assert(Result.isFailure(rolledBack), "Transaction should have failed.");
    assert(
        (yield* storage.get(users, "rollback")) === undefined && (yield* storage.get(tasks, 3)) === undefined,
        "Object writes were not atomic."
    );
    yield* errorReason(
        storage.put(tasks, { ...task, id: 4, rank: 4 }).pipe(storage.withReadTransaction),
        "TransactionError"
    );
    let escaped: StorageTransaction | undefined;
    yield* storage.transaction((tx) =>
        Effect.sync(() => {
            escaped = tx;
        })
    );
    yield* errorReason(escaped!.get(tasks, 1), "TransactionError");

    const presentation: OntologyIR = structuredClone(ir);
    presentation.objectTypes[1]!.displayName = "Renamed presentation";
    presentation.objectTypes.reverse();
    const same = yield* makeStorageModel({ namespace: model.namespace, ir: presentation, schemas });
    assert(
        (yield* makeOntologyStorage(same, tables).get(same.objects.Task, 1))?.id === 1,
        "Presentation edits changed storage identity."
    );
    const changed: OntologyIR = structuredClone(ir);
    changed.objectTypes[1]!.properties.find((property) => property.name === "rank")!.type = o.double({});
    const drifted = yield* makeStorageModel({ namespace: model.namespace, ir: changed, schemas });
    yield* errorReason(
        makeOntologyStorage(drifted, tables).get(drifted.objects.Task, 1),
        "DefinitionMismatch"
    );
    const other = yield* makeStorageModel({ namespace: "other_namespace", ir, schemas });
    assert(
        (yield* makeOntologyStorage(other, tables).get(other.objects.Task, 1)) === undefined,
        "Ontology namespaces leaked."
    );
    yield* errorReason(storage.get(other.objects.Task, 1), "ConfigurationError");
    yield* storage.delete(tasks, 1);
    assert(
        (yield* storage.get(tasks, 1)) === undefined && (yield* storage.get(users, "user"))?.name === "Owner",
        "Explicit deletion crossed object stores."
    );

    const typeChecks = () => {
        // @ts-expect-error Primary-key inputs follow the ontology definition and model.
        storage.get(tasks, "wrong");
        // @ts-expect-error Writes require the complete object shape.
        storage.put(tasks, { id: 2 });
    };
    void typeChecks;
});
