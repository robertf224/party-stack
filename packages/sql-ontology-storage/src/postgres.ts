import { transactionError } from "@party-stack/ontology-storage/driver";
import { OntologyStorageError } from "@party-stack/ontology-storage/tables";
import { Effect, Predicate, Schedule } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlClient } from "effect/sql/SqlClient";

/** Replay only failures PostgreSQL guarantees aborted, never a lost COMMIT reply. */
function transactionAborted(error: unknown): boolean {
    let cause = error;
    for (let depth = 0; depth < 8; depth++) {
        if (Predicate.hasProperty(cause, "code") && (cause.code === "40001" || cause.code === "40P01"))
            return true;
        if (isSqlError(cause)) cause = cause.reason.cause;
        else if (cause instanceof OntologyStorageError) cause = cause.reason.cause;
        else return false;
    }
    return false;
}

export const retryTransactions = <A, E, R>(
    enabled: boolean,
    attempt: (noteFailure: (error: unknown) => void) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
        let aborted = false;
        return Effect.suspend(() => {
            aborted = false;
            return attempt((error) => {
                aborted ||= transactionAborted(error);
            });
        }).pipe(
            Effect.retry({
                times: enabled ? 8 : 0,
                while: () => aborted,
                schedule: Schedule.exponential("2 millis"),
            })
        );
    });

export const allocateRevision = Effect.fnUntraced(function* (
    sql: SqlClient,
    prefix: string,
    stream: string,
    minimum: number
) {
    const identity = JSON.stringify([prefix, stream]);
    // This lock is acquired at publication and held through COMMIT. The clock
    // lives in a sequence, avoiding a shared MVCC row that would force retries.
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
    const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
    );
    const suffix = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, "0")
    ).join("");
    const sequence = `${prefix.slice(0, 20)}_rev_${suffix}`;
    yield* sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS "${sequence}"`);
    const rows = yield* sql<{ revision: string }>`SELECT nextval(${sequence}::regclass)::text AS revision`;
    let revision = Number(rows[0]!.revision);
    if (revision <= minimum) {
        revision = minimum + 1;
        yield* sql`SELECT setval(${sequence}::regclass, ${revision})`;
    }
    if (!Number.isSafeInteger(revision))
        return yield* transactionError("Backend", "Publication revision exhausted.");
    return revision;
});

/** Strict two-phase coordination for cooperating Tables writers. Point reads
 * retain shared key locks; writes upgrade the key. Predicate reads exclusively
 * guard the logical table, protecting absent rows and changing membership.
 * Ordinary snapshot readers never take these locks. */
export function coordination(sql: SqlClient, prefix: string, writable: boolean) {
    const held = new Map<string, "shared" | "exclusive">();
    const lock = Effect.fnUntraced(function* (identity: readonly string[], exclusive: boolean) {
        if (!writable) return;
        const key = JSON.stringify([prefix, ...identity]);
        const previous = held.get(key);
        if (previous === "exclusive" || (previous === "shared" && !exclusive)) return;
        if (exclusive) yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        else yield* sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
        held.set(key, exclusive ? "exclusive" : "shared");
    });
    return {
        point: Effect.fnUntraced(function* (table: string, key: string, write = false) {
            yield* lock(["table", table], false);
            yield* lock(["row", table, key], write);
        }),
        predicate: (table: string) => lock(["table", table], true),
        definition: (table: string) => lock(["table", table], false),
    };
}
