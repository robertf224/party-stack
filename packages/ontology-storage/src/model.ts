import { decodeValue, encodeValue } from "./storage/values.js";
import type { Expression } from "@party-stack/ontology-spec";

export type Key = string | number;
export type Scalar =
    | string
    | number
    | bigint
    | boolean
    | Date
    | null
    | undefined
    | { readonly [Symbol.toStringTag]: "Temporal.Instant" | "Temporal.PlainDate"; toString(): string };
/** Explicit reference; scalar literals never become field names based on position. */
export interface Field {
    readonly _tag: "Field";
    readonly path: readonly string[];
}
export interface Row<A> {
    readonly key: Key;
    readonly value: A;
}
export interface Index {
    readonly name: string;
    readonly field: Field;
    readonly unique?: boolean;
    /** Index each scalar array element once per row. */
    readonly multiEntry?: boolean;
}
/** The local binding through which storage filters read the current row. */
export const rowBinding = "row";
/** A storage filter: a spec expression from the storage subset, over the single
 * `rowBinding` row. Fields are `getAt` paths of that binding; other operands are
 * literals or `length` of a field. Supported operators are eq/ne/lt/lte/gt/gte,
 * in (with a literal list), contains, like/ilike, and/or/not.
 *
 * Storage semantics differ from general query evaluation in two documented ways:
 * a missing value is `undefined` and compares two-valued (it equals only another
 * missing value), and ordered comparisons use the total cross-type value order. */
export type Filter = Expression;
/** A builder operand: a field reference, a scalar literal or a filter expression. */
export type Operand = Field | Scalar | Expression;
export interface Order {
    readonly field: Field;
    readonly direction?: "asc" | "desc";
    /** Explicit nullish placement groups null and undefined as equal ordering values. */
    readonly nulls?: "first" | "last";
}
export interface Cursor {
    readonly values: readonly Scalar[];
    readonly key: Key;
}
export interface Query {
    readonly where?: Filter;
    readonly orderBy?: readonly Order[];
    readonly limit?: number;
    readonly offset?: number;
    /** Exclusive keyset cursor in the query's complete sort order. */
    readonly after?: Cursor;
}
export interface ReadTable<A> {
    readonly name: string;
    /** Version this when the persisted representation or index meaning changes. */
    readonly version: number;
    readonly decode: (encoded: string) => A;
}
export interface Table<A> extends ReadTable<A> {
    readonly encode: (value: A) => string;
}
export interface ValueCodec<A> {
    readonly encode: (value: A) => unknown;
    readonly decode: (value: unknown) => A;
}
export const Table = {
    make<A>(options: {
        readonly name: string;
        readonly codec?: ValueCodec<A>;
        readonly version?: number;
    }): Table<A> {
        if (!options.name || !Number.isSafeInteger(options.version ?? 1) || (options.version ?? 1) < 1) {
            throw new Error("Tables require a nonempty name and a positive integer version.");
        }
        return {
            name: options.name,
            version: options.version ?? 1,
            encode: (value) => encodeValue(options.codec ? options.codec.encode(value) : value),
            decode: (encoded) =>
                options.codec ? options.codec.decode(decodeValue(encoded)) : (decodeValue(encoded) as A),
        };
    },
};
export { OntologyStorageError } from "./errors.js";
export type { OntologyStorageErrorReason } from "./errors.js";
export const field = (...path: string[]): Field => ({ _tag: "Field", path });
/** The filter expression that reads a field of the current row. */
export const fieldExpression = (field: Field): Expression => ({
    kind: "getAt",
    value: { source: { kind: "localReference", value: { name: rowBinding } }, path: [...field.path] },
});
const literal = (value: unknown): Expression => ({ kind: "literal", value: { value } });
const isExpression = (value: unknown): value is Expression =>
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    typeof Reflect.get(value, "kind") === "string" &&
    Object.hasOwn(value, "value");
/** Fields read the row, expressions pass through and every other value is a literal. */
export const operand = (value: Operand): Expression =>
    value !== null && typeof value === "object" && Reflect.get(value, "_tag") === "Field"
        ? fieldExpression(value as Field)
        : isExpression(value)
          ? value
          : literal(value);
const binary =
    (kind: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "like" | "ilike") =>
    (left: Operand, right: Operand): Filter =>
        ({ kind, value: { left: operand(left), right: operand(right) } }) as Filter;
export const eq = binary("eq");
export const ne = binary("ne");
export const lt = binary("lt");
export const lte = binary("lte");
export const gt = binary("gt");
export const gte = binary("gte");
export const inArray = (left: Operand, values: readonly Scalar[]): Filter => ({
    kind: "in",
    value: { left: operand(left), right: literal([...values]) },
});
export const contains: (array: Field, value: Operand) => Filter = binary("contains");
export const like: (left: Operand, right: string | Field) => Filter = binary("like");
export const ilike: (left: Operand, right: string | Field) => Filter = binary("ilike");
export const isNull = (value: Operand): Filter => eq(value, null);
export const isUndefined = (value: Operand): Filter => eq(value, undefined);
/** Element count of a list field, or UTF-16 length of a string field. A missing value
 * has length 0, so `eq(length(field("tags")), 0)` matches missing and empty lists. */
export const length = (value: Field): Expression => ({
    kind: "length",
    value: { expression: fieldExpression(value) },
});
export const and = (...expressions: Filter[]): Filter => ({ kind: "and", value: { expressions } });
export const or = (...expressions: Filter[]): Filter => ({ kind: "or", value: { expressions } });
export const not = (expression: Filter): Filter => ({ kind: "not", value: { expression } });
/** Optional namespace for callers who prefer it. */
export const where = {
    eq,
    ne,
    lt,
    lte,
    gt,
    gte,
    in: inArray,
    contains,
    length,
    like,
    ilike,
    isNull,
    isUndefined,
    and,
    or,
    not,
};
