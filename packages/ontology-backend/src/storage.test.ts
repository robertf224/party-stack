import { o } from "@party-stack/ontology-spec";
import { context } from "@party-stack/ontology-spec/query";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { CurrentExecutionContext } from "./policy.js";
import { makeStorageBackend } from "./storage.js";
import type { StorageBackendOptions } from "./storage.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    context: {
        type: o.struct({ fields: [{ name: "tenant", displayName: "Tenant", type: o.string({}) }] }),
        partition: [["tenant"]],
    },
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            parameters: [
                {
                    name: "tenantHint",
                    displayName: "Tenant",
                    type: o.optional({ type: o.string({}) }),
                    defaultValue: context("tenant"),
                },
            ],
            logic: [],
        },
    ],
};

test("fixed storage bindings scope idempotency by the declared context partition, without requiring context.user", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const blobs = yield* makeBlobStorage({
                    namespace: "partition",
                    tables,
                    mode: "authoritative",
                    bytes: {
                        read: () => Effect.succeed(undefined),
                        write: () => Effect.void,
                        delete: () => Effect.void,
                    },
                });
                const options: StorageBackendOptions = {
                    namespace: "partition",
                    ir,
                    tables,
                    blobs,
                    mutators: {
                        increment: (tx) =>
                            Effect.gen(function* () {
                                const previous = yield* tx.get("Counter", "one");
                                yield* tx.put("Counter", {
                                    id: "one",
                                    count: Number(previous?.count ?? 0) + 1,
                                });
                            }),
                    },
                };
                const a = yield* makeStorageBackend({ ...options, context: { tenant: "a" } });
                const b = yield* makeStorageBackend({ ...options, context: { tenant: "b" } });
                expect(yield* a.resolveActionParameters("increment", {})).toEqual({ tenantHint: "a" });
                expect(
                    yield* a
                        .resolveActionParameters("increment", {})
                        .pipe(Effect.provideService(CurrentExecutionContext, { tenant: "b" }))
                ).toEqual({ tenantHint: "b" });
                const action = { id: "same-id", name: "increment", parameters: {} };
                const receiptA = yield* a.applyAction(action);
                const receiptB = yield* b.applyAction(action);
                expect(receiptA.cursor).not.toBe(receiptB.cursor);
                expect(yield* a.applyAction(action)).toEqual(receiptA);
                expect(yield* a.storage.read((tx) => tx.get("Counter", "one"))).toEqual({
                    id: "one",
                    count: 2,
                });
                expect(yield* Effect.result(makeStorageBackend({ ...options, context: {} }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidConfiguration", retryable: false },
                });
            })
        )
    );
});
