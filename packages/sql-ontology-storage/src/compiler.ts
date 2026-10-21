import {
    keyCode,
    scalarKey,
    caseInsensitiveIndex,
    type StoredIndex,
} from "@party-stack/ontology-storage/driver";
import {
    isField,
    type Field,
    type Operand,
    type Predicate,
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
                !i.multiEntry &&
                i.field.path.length === field.path.length &&
                i.field.path.every((part, n) => part === field.path[n])
        );
        return index
            ? indexExpression(dialect, insensitive ? caseInsensitiveIndex(index.name) : index.name)
            : undefined;
    };
    const predicate = (p: Predicate): Fragment => {
        const checkpoint = params.length;
        const unsupported = (): Fragment => {
            params.length = checkpoint;
            return unknown;
        };
        if (p.op === "and" || p.op === "or") {
            const children = p.predicates.map(predicate);
            if (p.op === "or" && children.some((c) => c.sql === undefined)) return unsupported();
            const available = children.flatMap((c) => (c.sql === undefined ? [] : [c.sql]));
            return {
                sql: available.length
                    ? `(${available.join(p.op === "and" ? " AND " : " OR ")})`
                    : p.op === "and"
                      ? "1=1"
                      : "1=0",
                complete: children.every((c) => c.complete),
            };
        }
        if (p.op === "not") {
            const child = predicate(p.predicate);
            return child.complete && child.sql !== undefined
                ? { sql: `(NOT ${child.sql})`, complete: true }
                : unsupported();
        }
        const operand = (value: Operand): string | undefined =>
            isField(value) ? expression(value) : bind(scalarKey(value));
        if (p.op === "contains") {
            const index = indexes.find(
                (i) =>
                    i.multiEntry &&
                    i.field.path.length === p.left.path.length &&
                    i.field.path.every((part, n) => part === p.left.path[n])
            );
            if (!index) return unsupported();
            const needle = operand(p.right);
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
        if (p.op === "like" || p.op === "ilike") {
            // Dynamic patterns and literal-left LIKE need exact residual evaluation.
            if (!isField(p.left) || typeof p.right !== "string") return unsupported();
            const expr = expression(p.left, p.op === "ilike");
            if (!expr) return unsupported();
            const pattern = p.op === "ilike" ? p.right.toLowerCase() : p.right;
            const wildcard = pattern.search(/[%_]/);
            if (wildcard < 0) return { sql: `${expr} = ${bind(scalarKey(pattern))}`, complete: true };
            const lower = scalarKey(pattern.slice(0, wildcard));
            return {
                sql: `(${expr} >= ${bind(lower)} AND ${expr} < ${bind(`${lower}g`)})`,
                complete: pattern.slice(wildcard) === "%",
            };
        }
        if (p.op === "in" && p.values.length === 0) return { sql: "1=0", complete: true };
        const left = operand(p.left);
        if (!left) return unsupported();
        if (p.op === "in") {
            if (p.values.length > 400) return unsupported();
            return {
                sql: p.values.length
                    ? `${left} IN (${[...new Set(p.values.map(scalarKey))].map(bind).join(",")})`
                    : "1=0",
                complete: true,
            };
        }
        const right = operand(p.right);
        if (!right) return unsupported();
        const operators = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
        return { sql: `${left} ${operators[p.op]} ${right}`, complete: true };
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
