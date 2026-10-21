/** Sparse keyed composition. Contains no outbox, sync, or replication protocol. */
import { Effect, Schema } from "effect";
import { queryError } from "../errors.js";
import { Table, OntologyStorageError, type Key, type Query, type Row, type ValueCodec } from "../model.js";
import { applyQuery, keyCode } from "../query/evaluate.js";
import type { ReadTransaction, Transaction } from "../tables.js";

export type Override<A> = { readonly deleted: true } | { readonly deleted: false; readonly value: A };
export interface Overlay<A> {
    readonly base: Table<A>;
    readonly overrides: Table<Override<A>>;
}
const decodeOverride = Schema.decodeUnknownSync(
    Schema.Union([
        Schema.Struct({ deleted: Schema.Literal(true) }),
        Schema.Struct({ deleted: Schema.Literal(false), encoded: Schema.String }),
    ])
);
export const overlay = <A>(base: Table<A>, options: { readonly name: string }): Overlay<A> => {
    // Preserve an optional custom base codec rather than persisting class instances.
    const codec: ValueCodec<Override<A>> = {
        encode: (entry) => (entry.deleted ? entry : { deleted: false, encoded: base.encode(entry.value) }),
        decode: (value) => {
            const entry = decodeOverride(value);
            return entry.deleted ? { deleted: true } : { deleted: false, value: base.decode(entry.encoded) };
        },
    };
    if (options.name === base.name) throw new Error("Base and overlay must have different table names.");
    return { base, overrides: Table.make({ name: options.name, codec, version: base.version }) };
};
/** Call within Tables.read/transaction so both sources share a consistent snapshot. */
export const loadVisible = Effect.fnUntraced(function* <A>(
    tx: ReadTransaction,
    view: Overlay<A>,
    query: Query = {}
): Effect.fn.Return<Row<A>[], OntologyStorageError> {
    const overrides = yield* tx.loadSubset(view.overrides);
    const shadowed = new Set(overrides.map((row) => keyCode(row.key)));
    const baseQuery: Query = {
        ...query,
        offset: 0,
        limit: query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit + shadowed.size,
    };
    const base = yield* tx.loadSubset(view.base, baseQuery);
    const merged: Row<A>[] = base.filter((row) => !shadowed.has(keyCode(row.key)));
    for (const row of overrides)
        if (!row.value.deleted) merged.push({ key: row.key, value: row.value.value });
    return yield* Effect.try({
        try: () => applyQuery(merged, query),
        catch: (cause) => queryError("overlay", cause),
    });
});
export const getVisible = Effect.fnUntraced(function* <A>(tx: ReadTransaction, view: Overlay<A>, key: Key) {
    const override = yield* tx.get(view.overrides, key);
    return override ? (override.deleted ? undefined : override.value) : yield* tx.get(view.base, key);
});
export const putVisible = <A>(tx: Transaction, view: Overlay<A>, key: Key, value: A) =>
    tx.put(view.overrides, key, { deleted: false, value });
export const deleteVisible = <A>(tx: Transaction, view: Overlay<A>, key: Key) =>
    tx.put(view.overrides, key, { deleted: true });
