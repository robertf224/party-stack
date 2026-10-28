import { o } from "../ir/generated/builders.js";
import type {
    CaseExpression,
    Expression,
    Query,
    QuerySelection,
    SelectCaseSelection,
} from "../ir/generated/types.js";

export type {
    Query,
    QueryDocument,
    QuerySelection,
    QuerySource,
    QueryFrom,
    QueryOrder,
    QueryPage,
    QueryCursor,
    Subset,
    BinaryExpression,
    VariadicExpression,
    CaseExpression,
    CaseBranch,
    SelectCaseSelection,
    SelectCaseBranch,
    ExistsExpression,
} from "../ir/generated/types.js";

/** Pure low-level construction. Schema-aware proxy builders produce these same nodes. */
export const literal = (value: unknown): Expression => o.Expression.literal({ value });
export const input = (name: string): Expression => o.Expression.inputReference({ name });
export const context = (name: string, ...path: string[]): Expression => {
    const source = o.Expression.contextReference({ name });
    return path.length ? o.Expression.getAt({ source, path }) : source;
};
export const row = (binding: string): Expression => o.Expression.localReference({ name: binding });
export const field = (binding: string, ...path: string[]): Expression =>
    o.Expression.getAt({ source: row(binding), path });

const binary =
    (
        kind:
            | "eq"
            | "ne"
            | "lt"
            | "lte"
            | "gt"
            | "gte"
            | "in"
            | "contains"
            | "like"
            | "ilike"
            | "add"
            | "subtract"
            | "multiply"
            | "divide"
    ) =>
    (left: Expression, right: Expression): Expression =>
        o.Expression[kind]({ left, right });
export const eq = binary("eq");
export const ne = binary("ne");
export const lt = binary("lt");
export const lte = binary("lte");
export const gt = binary("gt");
export const gte = binary("gte");
export const inArray = binary("in");
export const contains = binary("contains");
export const like = binary("like");
export const ilike = binary("ilike");
export const add = binary("add");
export const subtract = binary("subtract");
export const multiply = binary("multiply");
export const divide = binary("divide");
export const and = (...expressions: Expression[]): Expression => o.Expression.and({ expressions });
export const or = (...expressions: Expression[]): Expression => o.Expression.or({ expressions });
export const concat = (...expressions: Expression[]): Expression => o.Expression.concat({ expressions });
export const coalesce = (...expressions: Expression[]): Expression => o.Expression.coalesce({ expressions });
export const not = (expression: Expression): Expression => o.Expression.not({ expression });
export const caseExpression = (options: CaseExpression): Expression => o.Expression.case(options);
export const exists = (query: Query): Expression => o.Expression.exists({ query });

export const selectField = (name: string, expression: Expression): QuerySelection =>
    o.QuerySelection.field({ name, expression });
export const sub = (name: string, query: Query, cardinality: "one" | "many" = "many"): QuerySelection =>
    o.QuerySelection.sub({ name, query, cardinality });
export const selectCase = (options: SelectCaseSelection): QuerySelection =>
    o.QuerySelection.selectCase(options);

export { validateQueryDocument, selectedProperty } from "./validate.js";
export type { QueryValidationOptions } from "./validate.js";
export { equalValues, compareValues, evaluateOperator, matchPattern, booleanValue } from "./operators.js";

export { validatePolicy } from "./policy.js";
