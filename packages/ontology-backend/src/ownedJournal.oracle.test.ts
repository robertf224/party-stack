import { it } from "@effect/vitest";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { makeOwnedBackend } from "./owned.js";
import { objectSubset } from "./subset.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "value", displayName: "Value", type: o.integer({}) },
            ],
        },
    ],
};

it.live.prop(
    "journal replay and installed rows agree with a plain-map transaction oracle",
    [
        Schema.Array(
            Schema.Struct({
                rollback: Schema.Boolean,
                writes: Schema.Array(
                    Schema.Struct({
                        id: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
                        value: Schema.Int.check(
                            Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 })
                        ),
                        remove: Schema.Boolean,
                    })
                ).check(Schema.isMaxLength(8)),
            })
        ).check(Schema.isMaxLength(15)),
    ],
    ([batches]) =>
        Effect.gen(function* () {
            yield* Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "oracle",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                let expected = new Map<string, { id: string; value: number }>();
                const replayed = new Map<string, { id: string; value: number }>();
                let cursor: string | undefined;
                for (const batch of batches) {
                    const next = new Map(expected);
                    const result = yield* Effect.result(
                        backend.storage.transaction((tx) =>
                            Effect.gen(function* () {
                                for (const write of batch.writes) {
                                    const id = String(write.id);
                                    if (write.remove) {
                                        next.delete(id);
                                        yield* tx.delete("Item", id);
                                    } else {
                                        const value = { id, value: write.value };
                                        next.set(id, value);
                                        yield* tx.put("Item", value);
                                    }
                                }
                                if (batch.rollback) return yield* Effect.fail("rollback");
                            })
                        )
                    );
                    expect(result._tag === "Failure").toBe(batch.rollback);
                    if (!batch.rollback) expected = next;
                    for (;;) {
                        const page = yield* backend.changes!.pull({ cursor, limit: 1 });
                        for (const commit of page.commits)
                            for (const change of commit.changes)
                                if (change.kind === "delete") replayed.delete(String(change.key));
                                else
                                    replayed.set(
                                        String(change.key),
                                        change.value as { id: string; value: number }
                                    );
                        cursor = page.cursor;
                        if (!page.hasMore) break;
                    }
                    const sorted = (values: Iterable<{ id: string; value: number }>) =>
                        [...values].sort((a, b) => a.id.localeCompare(b.id));
                    expect(sorted(replayed.values())).toEqual(sorted(expected.values()));
                    expect(
                        (yield* backend.loadSubset(objectSubset("Item"))).rows.map((row) => row.value)
                    ).toEqual(sorted(expected.values()));
                }
            }).pipe(Effect.scoped);
        }),
    { arbitrary: { runs: 100 } }
);
