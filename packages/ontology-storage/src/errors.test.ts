import { assert, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { LockTimeoutError, SqlError } from "effect/sql/SqlError";
import { codecError, storageError, transactionError } from "./errors.js";
import { make } from "./memory/tables.js";
import {
    BlobStorageError,
    CodecError,
    QueryError,
    Table,
    OntologyStorageError,
    OntologyStorageErrorReason,
    UniqueConstraint,
} from "./table-api.js";

it.effect("Reasons are schema-backed errors and catchReason exposes typed details", () =>
    Effect.gen(function* () {
        const reason = new UniqueConstraint({ table: "tasks", index: "email", message: "Duplicate email" });
        const error = new OntologyStorageError({ operation: "put", reason });
        assert.instanceOf(reason, Error);
        assert.strictEqual(Schema.is(OntologyStorageErrorReason)(reason), true);
        assert.strictEqual(error.cause, reason);
        assert.strictEqual(error.isRetryable, false);
        const recovered = yield* Effect.fail(error).pipe(
            Effect.catchReason("OntologyStorageError", "UniqueConstraint", (e) =>
                Effect.succeed(`${e.table}/${e.index}`)
            )
        );
        assert.strictEqual(recovered, "tasks/email");
    })
);

it.effect("Reasons are yieldable and unwrapReason supports catchTag", () =>
    Effect.gen(function* () {
        const reason = new QueryError({ message: "Invalid cursor" });
        const yielded = Effect.gen(function* () {
            return yield* reason;
        });
        assert.strictEqual(
            yield* yielded.pipe(Effect.catchTag("QueryError", (e) => Effect.succeed(e.message))),
            "Invalid cursor"
        );
        const outer = Effect.fail(new OntologyStorageError({ operation: "loadSubset", reason }));
        assert.strictEqual(
            yield* outer.pipe(
                Effect.unwrapReason("OntologyStorageError"),
                Effect.catchTag("QueryError", (e) => Effect.succeed(e.message))
            ),
            "Invalid cursor"
        );
    })
);

it.effect("Handling one reason preserves unmatched storage failures and native causes", () =>
    Effect.gen(function* () {
        const sql = new SqlError({ reason: new LockTimeoutError({ cause: new Error("busy") }) });
        const error = storageError("sql", "query", sql, sql.isRetryable);
        const result = yield* Effect.fail(error).pipe(
            Effect.catchReason("OntologyStorageError", "UniqueConstraint", () =>
                Effect.succeed("unexpected")
            ),
            Effect.result
        );
        assert.strictEqual(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
            assert.strictEqual(result.failure, error);
            assert.strictEqual(result.failure.reason.cause, sql);
            assert.strictEqual(result.failure.isRetryable, true);
        }
        // Retrying a closed handle or invalid query cannot repair it.
        assert.strictEqual(transactionError("Closed", "closed", undefined, true).isRetryable, false);
        assert.strictEqual(
            new OntologyStorageError({ operation: "query", reason: new QueryError({ message: "bad" }) })
                .isRetryable,
            false
        );
    })
);

it("Error schemas round-trip concrete reason classes and validate input", () => {
    const cause = new TypeError("Cannot decode input");
    const error = codecError("decode", cause);
    assert.strictEqual(error.reason.cause, cause);
    const encoded = Schema.encodeSync(OntologyStorageError)(error);
    const decoded = Schema.decodeUnknownSync(OntologyStorageError)(JSON.parse(JSON.stringify(encoded)));
    assert.instanceOf(decoded, OntologyStorageError);
    assert.instanceOf(decoded.reason, CodecError);
    assert.instanceOf(decoded.reason.cause, Error);
    assert.strictEqual(decoded.reason.message, "Cannot decode input");
    assert.throws(
        () =>
            Schema.decodeUnknownSync(OntologyStorageError)({
                _tag: "OntologyStorageError",
                operation: "query",
                reason: { _tag: "QueryError" },
            }),
        /message/
    );
});

it.effect("Candidate decoding fails with CodecError rather than QueryError", () =>
    Effect.gen(function* () {
        const tables = yield* make();
        const cause = new Error("Decoder rejected storage");
        let reject = false;
        const table = Table.make<number>({
            name: "decode_failure",
            codec: {
                encode: (value) => value,
                decode: (value) => {
                    if (reject) throw cause;
                    return Schema.decodeUnknownSync(Schema.Number)(value);
                },
            },
        });
        yield* tables.put(table, "key", 1);
        reject = true;
        const reason = yield* tables.query(table).pipe(
            Effect.as(undefined),
            Effect.catchReason("OntologyStorageError", "CodecError", (error) => Effect.succeed(error))
        );
        assert.instanceOf(reason, CodecError);
        assert.strictEqual(reason?.direction, "decode");
        assert.strictEqual(reason?.cause, cause);
    })
);

it("attachment reasons remain catchable and retain their class across schema encoding", () => {
    const reason = new BlobStorageError({ kind: "NotFound", message: "Missing bytes" });
    const original = new OntologyStorageError({ operation: "attachment.retain", reason });
    const decoded = Schema.decodeUnknownSync(OntologyStorageError)(
        Schema.encodeSync(OntologyStorageError)(original)
    );
    assert.instanceOf(decoded.reason, BlobStorageError);
    assert.strictEqual(decoded.reason._tag, "BlobStorageError");
    assert.strictEqual(decoded.isRetryable, false);
    const busy = new OntologyStorageError({
        operation: "attachment.retain",
        reason: new BlobStorageError({ kind: "Busy", message: "Uploading" }),
    });
    assert.strictEqual(busy.isRetryable, true);
});
