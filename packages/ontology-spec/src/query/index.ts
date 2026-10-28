import { o } from "../ir/generated/builders.js";
import type { Expression, OperationExpression, Query, QuerySelection } from "../ir/generated/types.js";

export type {
    Query,
    QueryDocument,
    QuerySelection,
    QuerySource,
    QueryFrom,
    QueryJoin,
    QueryOrder,
    QueryPage,
    QueryCursor,
    OperationExpression,
    ConditionalExpression,
    QueryTestExpression,
} from "../ir/generated/types.js";

/** Low-level portable construction. Typed ontology/proxy builders can produce
 * these same nodes without requiring a different execution or policy language.
 */
export const literal = (value: unknown): Expression => o.Expression.literal({ value });
export const input = (name: string): Expression => o.Expression.inputReference({ name });
export const context = (name: string, ...path: string[]): Expression => {
    const source = o.Expression.contextReference({ name });
    return path.length ? o.Expression.getAt({ source, path }) : source;
};
export const row = (binding: string): Expression => o.Expression.localReference({ name: binding });
export const field = (binding: string, ...path: string[]): Expression =>
    o.Expression.getAt({ source: row(binding), path });
export const operation = (operator: OperationExpression["operator"], ...args: Expression[]): Expression =>
    o.Expression.operation({ operator, arguments: args });
export const conditional = (condition: Expression, whenTrue: Expression, whenFalse: Expression): Expression =>
    o.Expression.conditional({ condition, whenTrue, whenFalse });
export const some = (query: Query): Expression => o.Expression.queryTest({ test: "some", query });
export const none = (query: Query): Expression => o.Expression.queryTest({ test: "none", query });

export const value = (name: string, expression: Expression): QuerySelection =>
    o.QuerySelection.field({ name, expression });
export const nested = (name: string, query: Query, cardinality: "one" | "many" = "many"): QuerySelection =>
    o.QuerySelection.query({ name, query, cardinality });
export const when = (
    condition: Expression,
    whenTrue: QuerySelection[],
    whenFalse?: QuerySelection[]
): QuerySelection => o.QuerySelection.when({ condition, whenTrue, ...(whenFalse ? { whenFalse } : {}) });
