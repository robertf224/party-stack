import { Cause, Effect, Exit, Fiber } from "effect";
import { expect, test } from "vitest";
import { OntologyStorageError, QueryError } from "./errors.js";
import { make } from "./memory/tables.js";
import { Table, field, eq, contains } from "./model.js";

test("bulk indexes follow canonical custom-codec values", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* make();
            const table = Table.make<{ email: string; aliases: string[] }>({
                name: "canonical-preparation",
                codec: {
                    encode: (value) => ({
                        email: value.email.trim().toLowerCase(),
                        aliases: value.aliases.map((value) => value.trim().toLowerCase()),
                    }),
                    decode: (value) => value as { email: string; aliases: string[] },
                },
            });
            yield* tables.ensureIndex(table, { name: "email", field: field("email"), unique: true });
            yield* tables.ensureIndex(table, { name: "aliases", field: field("aliases"), multiEntry: true });
            const rows = Array.from({ length: 260 }, (_, index) => ({
                key: String(index),
                value: {
                    email: `  PERSON-${index}@EXAMPLE.COM `,
                    aliases: [` TAG-${index} `, `tag-${index}`],
                },
            }));
            yield* tables.putMany(table, rows);
            expect(
                yield* tables.query(table, { where: eq(field("email"), "person-129@example.com") })
            ).toEqual([
                { key: "129", value: { email: "person-129@example.com", aliases: ["tag-129", "tag-129"] } },
            ]);
            expect(
                (yield* tables.query(table, { where: contains(field("aliases"), "tag-129") })).map(
                    (row) => row.key
                )
            ).toEqual(["129"]);
        })
    );
});

test.each(["key", "encode", "decode", "index"] as const)(
    "bulk %s failures retain their classification, input order and validation-before-write behavior",
    async (kind) => {
        await Effect.runPromise(
            Effect.gen(function* () {
                const tables = yield* make();
                const encoded: number[] = [];
                const decoded: number[] = [];
                type Value = { position: number; rank: unknown };
                const table = Table.make<Value>({
                    name: "preparation-errors",
                    codec: {
                        encode: (value) => {
                            encoded.push(value.position);
                            if (kind === "encode" && value.position === 129)
                                throw new Error("encode failure");
                            return value;
                        },
                        decode: (input) => {
                            const value = input as Value;
                            decoded.push(value.position);
                            if (kind === "decode" && value.position === 129)
                                throw new Error("decode failure");
                            return value;
                        },
                    },
                });
                yield* tables.ensureIndex(table, { name: "rank", field: field("rank") });
                const rows = Array.from({ length: 260 }, (_, position) => ({
                    key: kind === "key" && position === 129 ? Number.NaN : position,
                    value: { position, rank: kind === "index" && position === 129 ? {} : position },
                }));
                const result = yield* Effect.exit(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const result = yield* Effect.exit(tx.putMany(table, rows));
                            expect(yield* tx.query(table)).toEqual([]);
                            return result;
                        })
                    )
                );
                expect(Exit.isSuccess(result)).toBe(true);
                if (Exit.isFailure(result)) return;
                expect(Exit.isFailure(result.value)).toBe(true);
                if (Exit.isSuccess(result.value)) return;
                const error = Cause.squash(result.value.cause);
                expect(error).toBeInstanceOf(OntologyStorageError);
                if (!(error instanceof OntologyStorageError)) return;
                expect(error.operation).toBe(kind);
                expect(error.reason._tag).toBe(
                    kind === "key" ? "QueryError" : kind === "index" ? "IndexError" : "CodecError"
                );
                if (error.reason._tag === "CodecError") expect(error.reason.direction).toBe(kind);
                expect(encoded).toEqual(
                    Array.from({ length: kind === "key" ? 129 : 130 }, (_, index) => index)
                );
                expect(decoded).toEqual(
                    Array.from(
                        { length: kind === "key" || kind === "encode" ? 129 : 130 },
                        (_, index) => index
                    )
                );
                expect(yield* tables.query(table)).toEqual([]);
            })
        );
    }
);

test("large preparation remains cooperatively interruptible and rolls back", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* make();
                let count = 0;
                const table = Table.make<number>({
                    name: "interrupt-preparation",
                    codec: {
                        encode: (value) => {
                            count++;
                            return value;
                        },
                        decode: (value) => value as number,
                    },
                });
                const rows = Array.from({ length: 2000 }, (_, index) => ({ key: index, value: index }));
                const fiber = yield* Effect.forkChild(tables.putMany(table, rows));
                yield* Effect.yieldNow;
                yield* Fiber.interrupt(fiber);
                expect(count).toBeGreaterThan(0);
                expect(count).toBeLessThan(2000);
                expect(yield* tables.query(table)).toEqual([]);
            })
        )
    );
});

test.each(["key", "value"] as const)("unexpected row %s getters remain defects", async (property) => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* make();
            const table = Table.make<number>({ name: "preparation-defect" });
            const failure =
                property === "key"
                    ? new Error("unexpected row getter")
                    : new OntologyStorageError({
                          operation: "getter",
                          reason: new QueryError({ message: "unexpected typed getter" }),
                      });
            const rows = Array.from({ length: 260 }, (_, index) => ({ key: index, value: index }));
            Object.defineProperty(rows[129], property, {
                get: () => {
                    throw failure;
                },
            });
            const result = yield* Effect.exit(tables.putMany(table, rows));
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isSuccess(result)) return;
            expect(Cause.hasDies(result.cause)).toBe(true);
            expect(Cause.hasFails(result.cause)).toBe(false);
            expect(Cause.squash(result.cause)).toBe(failure);
            expect(yield* tables.query(table)).toEqual([]);
        })
    );
});

test("ordinary and bulk unique conflicts precede later folded-index defects", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* make();
            let rejectRepeatedRank = false;
            type Value = { email: string; rank: number };
            const table = Table.make<Value>({
                name: "unique-before-folded-error",
                codec: {
                    encode: (value) => value,
                    decode: (input) => {
                        const value = input as Value;
                        let rankReads = 0;
                        return {
                            email: value.email,
                            get rank() {
                                if (rejectRepeatedRank && ++rankReads > 1)
                                    throw new Error("Later folded-index access failed");
                                return value.rank;
                            },
                        };
                    },
                },
            });
            yield* tables.ensureIndex(table, { name: "email", field: field("email"), unique: true });
            yield* tables.ensureIndex(table, { name: "rank", field: field("rank") });
            yield* tables.put(table, "existing", { email: "taken", rank: 1 });
            rejectRepeatedRank = true;
            const value = { email: "taken", rank: 2 };
            for (const write of [
                tables.put(table, "duplicate", value),
                tables.putMany(table, [{ key: "duplicate", value }]),
            ]) {
                const result = yield* Effect.exit(write);
                expect(Exit.isFailure(result)).toBe(true);
                if (Exit.isSuccess(result)) continue;
                const error = Cause.squash(result.cause);
                expect(error).toBeInstanceOf(OntologyStorageError);
                if (error instanceof OntologyStorageError) expect(error.reason._tag).toBe("UniqueConstraint");
            }
            const inspect = Table.make<Value>({ name: table.name });
            expect(yield* tables.query(inspect)).toEqual([
                { key: "existing", value: { email: "taken", rank: 1 } },
            ]);
        })
    );
});
