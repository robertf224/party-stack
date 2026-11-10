import type { QueryDocument } from "@party-stack/ontology-spec";
import type { Query, Row, OntologyStorageError } from "@party-stack/ontology-storage";
import type {
    ReadTable,
    ReadTransaction,
    TableQuery,
    TableQueryOptions,
    Transaction,
} from "@party-stack/ontology-storage/tables";
import type { Effect } from "effect";

/** Replica object installation enforces value[primaryKey] === stored row key.
 * Its final ascending PK term is therefore the storage query's implicit key
 * suffix. Preserve malformed or non-row cursor tuples for ordinary validation
 * and evaluation instead of silently changing their boundary.
 */
export function primaryKeyOrder(query: Query, primaryKey: string): Query {
    if (!Array.isArray(query.orderBy) || !query.orderBy.length) return query;
    const last = query.orderBy.at(-1);
    if (
        last?.field?._tag !== "Field" ||
        !Array.isArray(last.field.path) ||
        last.field.path.length !== 1 ||
        last.field.path[0] !== primaryKey ||
        (last.direction !== undefined && last.direction !== "asc") ||
        (last.nulls !== undefined && last.nulls !== "first" && last.nulls !== "last")
    )
        return query;
    if (
        query.after &&
        (!Array.isArray(query.after.values) ||
            query.after.values.length !== query.orderBy.length ||
            query.after.values.at(-1) !== query.after.key)
    )
        return query;
    return {
        ...query,
        orderBy: query.orderBy.slice(0, -1),
        ...(query.after ? { after: { ...query.after, values: query.after.values.slice(0, -1) } } : {}),
    };
}

/** Static IR/table metadata only; unknown tables retain their original query. */
export function primaryKeyTableQuery(
    query: TableQuery,
    primaryKeys: ReadonlyMap<ReadTable<unknown>, string>
): TableQuery {
    function translated(
        document: QueryDocument,
        options: TableQueryOptions
    ): Effect.Effect<Record<string, unknown>, OntologyStorageError>;
    function translated<A>(table: ReadTable<A>, scan?: Query): Effect.Effect<Row<A>[], OntologyStorageError>;
    function translated(
        request: QueryDocument | ReadTable<unknown>,
        options: TableQueryOptions | Query = {}
    ): Effect.Effect<Record<string, unknown> | Row<unknown>[], OntologyStorageError> {
        if ("select" in request) return query(request, options as TableQueryOptions);
        const primaryKey = primaryKeys.get(request);
        return query(
            request,
            primaryKey === undefined ? (options as Query) : primaryKeyOrder(options as Query, primaryKey)
        );
    }
    return translated;
}
export function primaryKeyQueries(
    tx: Transaction,
    primaryKeys: ReadonlyMap<ReadTable<unknown>, string>
): Transaction;
export function primaryKeyQueries(
    tx: ReadTransaction,
    primaryKeys: ReadonlyMap<ReadTable<unknown>, string>
): ReadTransaction;
export function primaryKeyQueries(
    tx: ReadTransaction,
    primaryKeys: ReadonlyMap<ReadTable<unknown>, string>
): ReadTransaction {
    return { ...tx, query: primaryKeyTableQuery(tx.query, primaryKeys) };
}
