import {
    keyCode,
    scalarKey,
    caseInsensitiveIndex,
    fieldIndex,
    sizeRanges,
    type Range,
    type StoredIndex,
} from "@party-stack/ontology-storage/driver";
import {
    filterOperand,
    inValues,
    isComparison,
    lengthComparison,
    lengthEmptiness,
    type Field,
    type Filter,
    type FilterOperand,
    type Query,
} from "@party-stack/ontology-storage/tables";

export type Dialect = "sqlite" | "pg";
// Hex identifiers keep arbitrary logical index names out of SQL/JSON syntax.
export const projectionKey = (index: string): string => `x${keyCode(index).slice(1)}`;
// Explicit PG escape strings remain safe even with standard_conforming_strings=off.
export const literal = (dialect: Dialect, value: string): string =>
    dialect === "pg"
        ? `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
        : `'${value.replaceAll("'", "''")}'`;
export const indexExpression = (dialect: Dialect, index: string): string =>
    dialect === "sqlite"
        ? `(json_extract(projection, '$.${projectionKey(index)}') COLLATE BINARY)`
        : `((projection ->> '${projectionKey(index)}') COLLATE "C")`;
export const arrayIndexExpression = (dialect: Dialect, index: string): string =>
    dialect === "pg"
        ? `COALESCE(projection -> '${projectionKey(index)}', '[]'::jsonb)`
        : `json_extract(projection, '$.${projectionKey(index)}')`;
interface Fragment {
    readonly sql: string | undefined;
    readonly complete: boolean;
}
const unknown: Fragment = { sql: undefined, complete: false };

// String projections encode each UTF-16 unit as four ASCII hex digits. Match
// that representation so SQL collation/Unicode/escape rules cannot change LIKE.
function encodedPattern(pattern: string) {
    let like = "6",
        regex = "^6",
        stars = 0;
    for (let i = 0; i < pattern.length; i++) {
        const unit = pattern[i]!;
        if (unit === "%") {
            if (i && pattern[i - 1] === "%") continue;
            stars++;
            like += "%";
            regex += "([0-9a-f]{4})*";
        } else if (unit === "_") {
            like += "____";
            regex += "[0-9a-f]{4}";
        } else {
            const encoded = scalarKey(unit).slice(1);
            like += encoded;
            regex += encoded;
        }
    }
    return { like, regex: `${regex}$`, stars };
}

/** Let the engine plan a necessary predicate; leave only unsupported semantics as residuals. */
export function compileQuery(dialect: Dialect, indexes: readonly StoredIndex[], query: Query) {
    const params: (string | number)[] = [];
    const bind = (value: string | number): string => {
        params.push(value);
        return dialect === "pg" ? `$${params.length}` : "?";
    };
    const expression = (field: Field, insensitive = false): string | undefined => {
        const index = indexes.find(
            (i) =>
                fieldIndex(i) &&
                i.field.path.length === field.path.length &&
                i.field.path.every((part, n) => part === field.path[n])
        );
        return index
            ? indexExpression(dialect, insensitive ? caseInsensitiveIndex(index.name) : index.name)
            : undefined;
    };
    const sameField = (a: Field, b: Field) =>
        a.path.length === b.path.length && a.path.every((part, n) => part === b.path[n]);
    const arrayIndex = (field: Field) => indexes.find((i) => i.multiEntry && sameField(i.field, field));
    const sizeIndex = (field: Field) => indexes.find((i) => i.size && sameField(i.field, field));
    /** Size index keys within any of the ranges. */
    const sizeCondition = (field: Field, ranges: readonly Range[] | undefined): Fragment | undefined => {
        const index = sizeIndex(field);
        if (!index || !ranges) return undefined;
        const expr = indexExpression(dialect, index.name);
        const terms = ranges.map((range) => {
            const bounds = [
                ...(range.lower === undefined
                    ? []
                    : [`${expr} ${range.lowerOpen ? ">" : ">="} ${bind(range.lower)}`]),
                ...(range.upper === undefined
                    ? []
                    : [`${expr} ${range.upperOpen ? "<" : "<="} ${bind(range.upper)}`]),
            ];
            return bounds.length ? `(${bounds.join(" AND ")})` : "1=1";
        });
        return { sql: terms.length ? `(${terms.join(" OR ")})` : "1=0", complete: true };
    };
    // Without a size index, a multi-entry projection can still answer emptiness. It holds the
    // distinct element codes and no entry for a missing list, so never other lengths.
    const lengthExpression = (field: Field): string | undefined => {
        const index = arrayIndex(field);
        if (!index) return undefined;
        return dialect === "pg"
            ? `jsonb_array_length(${arrayIndexExpression(dialect, index.name)})`
            : `COALESCE(json_array_length(projection, '$.${projectionKey(index.name)}'), 0)`;
    };
    const predicate = (p: Filter): Fragment => {
        const checkpoint = params.length;
        const unsupported = (): Fragment => {
            params.length = checkpoint;
            return unknown;
        };
        if (p.kind === "and" || p.kind === "or") {
            const children = p.value.expressions.map(predicate);
            if (p.kind === "or" && children.some((c) => c.sql === undefined)) return unsupported();
            const available = children.flatMap((c) => (c.sql === undefined ? [] : [c.sql]));
            return {
                sql: available.length
                    ? `(${available.join(p.kind === "and" ? " AND " : " OR ")})`
                    : p.kind === "and"
                      ? "1=1"
                      : "1=0",
                complete: children.every((c) => c.complete),
            };
        }
        if (p.kind === "not") {
            const child = predicate(p.value.expression);
            return child.complete && child.sql !== undefined
                ? { sql: `(NOT ${child.sql})`, complete: true }
                : unsupported();
        }
        if (!("left" in p.value)) return unsupported();
        const left = filterOperand(p.value.left);
        const right = filterOperand(p.value.right);
        if (!left || !right) return unsupported();
        // Only scalar operands bind; a length compiles only as an emptiness test.
        const operand = (value: FilterOperand): string | undefined =>
            value.kind === "field"
                ? expression(value.field)
                : value.kind === "literal"
                  ? bind(scalarKey(value.value))
                  : undefined;
        if (p.kind === "contains") {
            if (left.kind !== "field") return unsupported();
            const index = arrayIndex(left.field);
            if (!index) return unsupported();
            const needle = operand(right);
            if (!needle) return unsupported();
            const array = arrayIndexExpression(dialect, index.name);
            return {
                sql:
                    dialect === "pg"
                        ? `(${array} ? ${needle})`
                        : `EXISTS (SELECT 1 FROM json_each(${array}) AS member WHERE member.value = ${needle} COLLATE BINARY)`,
                complete: true,
            };
        }
        if (p.kind === "like" || p.kind === "ilike") {
            // Dynamic patterns and literal-left LIKE need exact residual evaluation.
            if (left.kind !== "field" || right.kind !== "literal" || typeof right.value !== "string")
                return unsupported();
            const expr = expression(left.field, p.kind === "ilike");
            if (!expr) return unsupported();
            const pattern = p.kind === "ilike" ? right.value.toLowerCase() : right.value;
            const wildcard = pattern.search(/[%_]/);
            if (wildcard < 0) return { sql: `${expr} = ${bind(scalarKey(pattern))}`, complete: true };
            const lower = scalarKey(pattern.slice(0, wildcard));
            const prefix = `(${expr} >= ${bind(lower)} AND ${expr} < ${bind(`${lower}g`)})`;
            if (pattern.slice(wildcard) === "%") return { sql: prefix, complete: true };
            // Avoid engine-specific regex/LIKE program-size limits; the exact
            // shared matcher remains available for large client patterns.
            if (pattern.length > 256) return { sql: prefix, complete: false };
            const encoded = encodedPattern(pattern);
            if (dialect === "pg")
                return { sql: `(${prefix} AND ${expr} ~ ${bind(encoded.regex)})`, complete: true };
            // With zero/one %, fixed-width surrounding tokens force alignment.
            // Multiple % segments can match between code units; SQLite keeps a
            // residual rather than pretending that native LIKE is exact there.
            if (encoded.stars <= 1)
                return { sql: `(${prefix} AND ${expr} LIKE ${bind(encoded.like)})`, complete: true };
            return {
                sql: prefix,
                complete: false,
            };
        }
        if (p.kind === "in") {
            const values = inValues(p);
            if (values.length === 0) return { sql: "1=0", complete: true };
            if (values.length > 400) return unsupported();
            const target = operand(left);
            if (!target) return unsupported();
            return {
                sql: `${target} IN (${[...new Set(values.map(scalarKey))].map(bind).join(",")})`,
                complete: true,
            };
        }
        if (!isComparison(p)) return unsupported();
        // A length compiles only as an emptiness test of a multi-entry projection.
        const counted = lengthComparison(p);
        if (counted) {
            const sized = sizeCondition(counted.field, sizeRanges(counted.op, counted.bound));
            if (sized) return sized;
            const empty = lengthEmptiness(counted.op, counted.bound);
            const length = lengthExpression(counted.field);
            if (empty === undefined || !length) return unsupported();
            return { sql: `${length} ${empty ? "=" : ">"} 0`, complete: true };
        }
        // A list has no field index; its size index keys a missing list as the missing value.
        const [checked, other] = left.kind === "field" ? [left, right] : [right, left];
        if (
            (p.kind === "eq" || p.kind === "ne") &&
            checked.kind === "field" &&
            other.kind === "literal" &&
            other.value == null &&
            !expression(checked.field)
        ) {
            const key = scalarKey(other.value);
            const sized = sizeCondition(
                checked.field,
                p.kind === "eq"
                    ? [{ lower: key, upper: key }]
                    : [
                          { upper: key, upperOpen: true },
                          { lower: key, lowerOpen: true },
                      ]
            );
            if (sized) return sized;
        }
        const a = operand(left);
        if (!a) return unsupported();
        const b = operand(right);
        if (!b) return unsupported();
        const operators = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
        return { sql: `${a} ${operators[p.kind]} ${b}`, complete: true };
    };
    const where = query.where ? predicate(query.where) : { sql: "1=1", complete: true };
    const ordering = (query.orderBy ?? []).flatMap<{
        expr: string | undefined;
        desc: boolean;
        value: string | number;
    }>((o, i) => {
        const expr = expression(o.field);
        const value = query.after?.values[i];
        if (!o.nulls || !expr) return [{ expr, desc: o.direction === "desc", value: scalarKey(value) }];
        const nullish = `${expr} IN ('0','1')`;
        return [
            {
                expr: `(CASE WHEN ${nullish} THEN ${o.nulls === "first" ? 0 : 1} ELSE ${o.nulls === "first" ? 1 : 0} END)`,
                desc: false,
                value: value == null ? (o.nulls === "first" ? 0 : 1) : o.nulls === "first" ? 1 : 0,
            },
            {
                expr: `(CASE WHEN ${nullish} THEN '' ELSE ${expr} END)`,
                desc: o.direction === "desc",
                value: value == null ? "" : scalarKey(value),
            },
        ];
    });
    const knownOrder = ordering.every((o) => o.expr !== undefined);
    let complete = where.complete && knownOrder;
    let condition = where.sql ?? "1=1";
    if (query.after && knownOrder) {
        const terms = [
            ...ordering.map((o) => ({ expr: o.expr!, desc: o.desc, value: o.value })),
            { expr: "row_key", desc: false, value: keyCode(query.after.key) },
        ];
        condition += ` AND (${terms.map((term, i) => `(${[...terms.slice(0, i).map((before) => `${before.expr} = ${bind(before.value)}`), `${term.expr} ${term.desc ? "<" : ">"} ${bind(term.value)}`].join(" AND ")})`).join(" OR ")})`;
    }
    const order = [
        ...(knownOrder ? ordering.map((o) => `${o.expr} ${o.desc ? "DESC" : "ASC"}`) : []),
        "row_key ASC",
    ].join(",");
    let pagination = "";
    if (complete) {
        pagination =
            query.limit === undefined
                ? query.offset !== undefined && dialect === "sqlite"
                    ? " LIMIT -1"
                    : ""
                : ` LIMIT ${bind(query.limit)}`;
        if (query.offset !== undefined) pagination += ` OFFSET ${bind(query.offset)}`;
    }
    // A very large predicate/cursor remains correct without exceeding driver variable limits.
    if (params.length > 500) {
        params.length = 0;
        condition = "1=1";
        pagination = "";
        complete = false;
    }
    return { condition, order, pagination, params, complete };
}

/** Rank only after the complete predicate and portable ordering are native.
 * Unsupported predicates/projections must never consume a partition's window. */
export function compileGroupedQuery(
    dialect: Dialect,
    indexes: readonly StoredIndex[],
    partition: Field,
    query: Query
) {
    if (query.after) return;
    const index = indexes.find(
        (index) =>
            fieldIndex(index) &&
            index.field.path.length === partition.path.length &&
            index.field.path.every((part, i) => part === partition.path[i])
    );
    if (!index) return;
    const plan = compileQuery(dialect, indexes, { ...query, limit: undefined, offset: undefined });
    if (!plan.complete) return;
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    if (end !== undefined && !Number.isSafeInteger(end)) return;
    const bind = (value: number) => {
        plan.params.push(value);
        return dialect === "pg" ? `$${plan.params.length}` : "?";
    };
    const window = `row_rank > ${bind(offset)}${end === undefined ? "" : ` AND row_rank <= ${bind(end)}`}`;
    if (plan.params.length > 500) return;
    return { ...plan, partition: indexExpression(dialect, index.name), window };
}
