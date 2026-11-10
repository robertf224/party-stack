import { BackendError } from "@party-stack/ontology-backend";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { overlay } from "@party-stack/ontology-storage/overlay";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test } from "vitest";
import { encryptedCacheCodec, cachedCopy, withCachedCopy } from "./encryptedCache.js";
import { putIncomingRow, putIncomingBaseRows } from "./incoming.js";
import { deliveryRecovery } from "./recovery.js";
import type { Encrypted } from "@party-stack/ontology-spec/values";
import type { OntologyStorageError } from "@party-stack/ontology-storage";

test("incoming base batches preserve only device copies of unchanged encrypted values", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const base = Table.make<Record<string, unknown>>({
                name: "batch-encrypted-base",
                codec: encryptedCacheCodec(
                    { encode: (value) => value, decode: (value) => value as Record<string, unknown> },
                    ["secret"]
                ),
            });
            const view = overlay(base, { name: "batch-encrypted-overlay" });
            for (const id of ["a", "b"])
                yield* tables.put(base, id, {
                    id,
                    secret: withCachedCopy({ ciphertext: "old" }, { ciphertext: "device" }),
                });
            yield* tables.transaction((tx) =>
                putIncomingBaseRows(
                    tx,
                    view,
                    "id",
                    ["secret"],
                    [
                        { key: "a", value: { id: "a", secret: { ciphertext: "old" } } },
                        { key: "b", value: { id: "b", secret: { ciphertext: "new" } } },
                    ]
                )
            );
            expect(cachedCopy((yield* tables.get(base, "a"))!.secret as Encrypted)?.ciphertext).toBe(
                "device"
            );
            expect(cachedCopy((yield* tables.get(base, "b"))!.secret as Encrypted)).toBeUndefined();
        })
    );
});

test.each(["key", "codec"] as const)(
    "incoming base batch %s failures are typed and roll back the transaction",
    async (invalid) => {
        await Effect.runPromise(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const schema = Schema.Struct({ id: Schema.String, count: Schema.Number });
                const base = Table.make<Record<string, unknown>>({
                    name: "batch-validated-base",
                    codec: {
                        encode: Schema.encodeUnknownSync(schema),
                        decode: Schema.decodeUnknownSync(schema),
                    },
                });
                const view = overlay(base, { name: "batch-validated-overlay" });
                yield* tables.put(base, "seed", { id: "seed", count: 0 });
                const result = yield* Effect.result(
                    tables.transaction((tx) =>
                        putIncomingBaseRows(
                            tx,
                            view,
                            "id",
                            [],
                            [
                                { key: "one", value: { id: "one", count: 1 } },
                                {
                                    key: "two",
                                    value: {
                                        id: invalid === "key" ? "different" : "two",
                                        count: invalid === "codec" ? "bad" : 2,
                                    },
                                },
                            ]
                        )
                    )
                );
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "BackendError", kind: "InvalidResponse" },
                });
                expect(yield* tables.query(base)).toEqual([{ key: "seed", value: { id: "seed", count: 0 } }]);
            })
        );
    }
);

test("malformed upstream rows fail in the typed Effect channel, never as form validation or a defect", async () => {
    expectTypeOf<Effect.Error<ReturnType<typeof putIncomingRow>>>().toEqualTypeOf<
        BackendError<"InvalidResponse"> | OntologyStorageError
    >();
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const base = Table.make<Record<string, unknown>>({ name: "base" });
                const view = overlay(base, { name: "overlay" });
                const invalid = tables.transaction((tx) =>
                    putIncomingRow(tx, view, "id", [], "one", { kind: "base", value: { id: "different" } })
                );
                const result = yield* Effect.result(invalid);
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "BackendError", kind: "InvalidResponse" },
                });
                expect(
                    yield* invalid.pipe(
                        Effect.catchTag("BackendError", (error) => Effect.succeed(error.kind))
                    )
                ).toBe("InvalidResponse");
                expect(yield* tables.get(base, "one")).toBeUndefined();
            })
        )
    );
});

test.each([
    ["ViewReplaced", "selection"],
    ["HistoryExpired", "snapshot"],
    ["SessionExpired", "session"],
    ["SessionReplaced", "session"],
    ["Unavailable", "reconnect"],
    ["RateLimited", "reconnect"],
    ["InvalidResponse", "stop"],
    ["InvalidConfiguration", "stop"],
    ["SchemaMismatch", "stop"],
    ["SourceMismatch", "stop"],
    ["ResultExpired", "stop"],
] as const)("%s selects %s recovery without resetting the Replica itself", (kind, recovery) => {
    expect(
        deliveryRecovery(new BackendError({ operation: "test", kind, message: "test", retryable: true }))
    ).toBe(recovery);
});
