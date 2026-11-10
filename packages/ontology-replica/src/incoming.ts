import { BackendError } from "@party-stack/ontology-backend";
import { OntologyStorageError } from "@party-stack/ontology-storage";
import { Effect, Redacted } from "effect";
import { preserveCachedCopies } from "./encryptedCache.js";
import type { Key, Row } from "@party-stack/ontology-storage";
import type { Overlay, Override } from "@party-stack/ontology-storage/overlay";
import type { Transaction } from "@party-stack/ontology-storage/tables";

/** Shared object installation for snapshots, journal changes and selected patches.
 * The caller owns coverage, action settlement and the enclosing transaction.
 */
export const putIncomingRow = Effect.fnUntraced(
    function* (
        tx: Transaction,
        view: Overlay<Record<string, unknown>>,
        primaryKey: string,
        properties: readonly string[],
        key: Key,
        record:
            | { kind: "base"; value: Record<string, unknown> }
            | { kind: "override"; value: Override<Record<string, unknown>> }
    ) {
        const value =
            record.kind === "base" ? record.value : record.value.deleted ? undefined : record.value.value;
        if (value && value[primaryKey] !== key)
            return yield* new BackendError({
                operation: "replica.install",
                kind: "InvalidResponse",
                retryable: false,
                message: "Incoming row key does not match its primary key.",
            });
        if (record.kind === "base") {
            const previous = properties.length ? yield* tx.get(view.base, key) : undefined;
            yield* tx.put(view.base, key, preserveCachedCopies(previous, record.value, properties));
        } else {
            if (!view.inherited)
                return yield* new BackendError({
                    operation: "replica.install",
                    kind: "InvalidResponse",
                    retryable: false,
                    message: "A committed source cannot publish speculative overrides.",
                });
            const previous = yield* tx.get(view.inherited, key);
            yield* tx.put(
                view.inherited,
                key,
                record.value.deleted
                    ? record.value
                    : {
                          deleted: false,
                          value: preserveCachedCopies(
                              previous && !previous.deleted ? previous.value : yield* tx.get(view.base, key),
                              record.value.value,
                              properties
                          ),
                      }
            );
        }
    },
    (work) =>
        work.pipe(
            Effect.mapError((error) =>
                error instanceof OntologyStorageError && error.reason._tag === "CodecError"
                    ? new BackendError({
                          operation: "replica.install",
                          kind: "InvalidResponse",
                          retryable: false,
                          message: "Incoming row does not match its definition.",
                          cause: Redacted.make(error),
                      })
                    : error
            )
        )
);

/** Distinct base keys can be installed together without observing intermediate rows.
 * The caller flushes before dependent changes and retains the enclosing transaction.
 */
export const putIncomingBaseRows = Effect.fnUntraced(
    function* (
        tx: Transaction,
        view: Overlay<Record<string, unknown>>,
        primaryKey: string,
        properties: readonly string[],
        rows: readonly Row<Record<string, unknown>>[]
    ) {
        if (!rows.length) return;
        for (const row of rows)
            if (row.value[primaryKey] !== row.key)
                return yield* new BackendError({
                    operation: "replica.install",
                    kind: "InvalidResponse",
                    retryable: false,
                    message: "Incoming row key does not match its primary key.",
                });
        const previous = properties.length
            ? new Map(
                  (yield* tx.getMany(
                      view.base,
                      rows.map((row) => row.key)
                  )).map((row) => [row.key, row.value])
              )
            : undefined;
        yield* tx.putMany(
            view.base,
            rows.map((row) => ({
                key: row.key,
                value: preserveCachedCopies(previous?.get(row.key), row.value, properties),
            }))
        );
    },
    (work) =>
        work.pipe(
            Effect.mapError((error) =>
                error instanceof OntologyStorageError && error.reason._tag === "CodecError"
                    ? new BackendError({
                          operation: "replica.install",
                          kind: "InvalidResponse",
                          retryable: false,
                          message: "Incoming row does not match its definition.",
                          cause: Redacted.make(error),
                      })
                    : error
            )
        )
);
