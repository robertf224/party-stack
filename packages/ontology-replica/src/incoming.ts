import { BackendError } from "@party-stack/ontology-backend";
import { OntologyStorageError } from "@party-stack/ontology-storage";
import { Effect, Redacted } from "effect";
import { preserveCachedCopies } from "./encryptedCache.js";
import type { Key } from "@party-stack/ontology-storage";
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
