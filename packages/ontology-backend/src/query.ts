import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import {
    booleanValue,
    evaluateOperator,
    validateQueryDocument,
    selectedProperty,
} from "@party-stack/ontology-spec/query";
import { certain, uncertain } from "@party-stack/ontology-spec/utils";
import { isRelatedFromForeignKeySource, resolveRelatedLink } from "@party-stack/ontology-spec/utils";
import { field, and, eq, ne, not, or, inArray, contains, like, ilike } from "@party-stack/ontology-storage";
import { compareScalar, readField, scalarKey } from "@party-stack/ontology-storage/query";
import { Effect, Schema } from "effect";
import { BackendError } from "./index.js";
import type {
    Expression,
    FieldDef,
    OntologyIR,
    Query,
    QueryDocument,
    QuerySelection,
    QuerySource,
    TypeDef,
} from "@party-stack/ontology-spec";
import type { Uncertain } from "@party-stack/ontology-spec/utils";
import type { Key, Operand, Predicate, Query as Scan, Row, Scalar } from "@party-stack/ontology-storage";

export interface QueryReader {
    readonly ir: OntologyIR;
    readonly loadSubset: (
        objectType: string,
        subset?: Scan
    ) => Effect.Effect<readonly Row<Record<string, unknown>>[], BackendError>;
}
export interface QueryEntity {
    readonly source?: string;
    readonly objectType: string;
    readonly key: Key;
    readonly value: Record<string, unknown>;
    readonly properties: Set<string>;
}
export interface QueryExecutionOptions {
    readonly reader: QueryReader;
    readonly sources?: Readonly<Record<string, QueryReader>>;
    readonly inputs?: Record<string, unknown>;
    readonly inputDefinitions?: readonly FieldDef[];
    readonly knownInputs?: ReadonlySet<string>;
    readonly context?: Record<string, unknown>;
    readonly mode?: "projection" | "entity";
    readonly strategy?: "planned" | "reference";
    readonly canReadProperty?: (entity: QueryEntity, property: string) => boolean;
}
const fail = (message: string, kind: BackendError["kind"] = "InvalidRequest") =>
    new BackendError({ operation: "query", kind, message, retryable: false });
const attempt = <A>(f: () => A) =>
    Effect.try({
        try: f,
        catch: (cause) =>
            cause instanceof BackendError
                ? cause
                : fail(cause instanceof Error ? cause.message : "Query evaluation failed."),
    });
type Scope = Map<string, unknown>;

/** One finite execution. Readers own snapshot/cancellation guarantees; no state survives the call. */
export function queryExecutor(options: QueryExecutionOptions) {
    const ir = options.reader.ir;
    const input = options.inputs ?? {},
        context = options.context ?? {};
    const rowEntities = new WeakMap<object, QueryEntity>();
    const grants = new Map<string, QueryEntity>();
    const source = (ref: QuerySource) => {
        const reader = ref.ontology ? options.sources?.[ref.ontology] : options.reader;
        if (!reader || !reader.ir.objectTypes.some((t) => t.name === ref.objectType))
            throw fail("Unknown query source.");
        return reader;
    };
    const fetch = Effect.fnUntraced(function* (ref: QuerySource, scan: Scan = {}) {
        const reader = yield* attempt(() => source(ref));
        const rows = yield* reader.loadSubset(ref.objectType, scan);
        for (const row of rows)
            rowEntities.set(row.value, {
                source: ref.ontology,
                objectType: ref.objectType,
                key: row.key,
                value: row.value,
                properties: new Set(),
            });
        return rows;
    });
    const resolve = (type: TypeDef | undefined, seen = new Set<string>()): TypeDef | undefined => {
        if (type?.kind === "optional") return resolve(type.value.type, seen);
        if (type?.kind !== "ref") return type;
        if (seen.has(type.value.name)) return undefined;
        return resolve(
            ir.types.find((t) => t.name === type.value.name)?.type,
            new Set([...seen, type.value.name])
        );
    };
    const referenceType = (e: Expression): TypeDef | undefined => {
        if (e.kind === "inputReference")
            return resolve(options.inputDefinitions?.find((p) => p.name === e.value.name)?.type);
        if (e.kind === "contextReference") {
            const type = resolve(ir.context?.type);
            return resolve(
                type?.kind === "struct"
                    ? type.value.fields.find((f) => f.name === e.value.name)?.type
                    : undefined
            );
        }
        if (e.kind === "getAt") {
            let type = referenceType(e.value.source);
            for (const p of e.value.path)
                type = resolve(
                    type?.kind === "struct" ? type.value.fields.find((f) => f.name === p)?.type : undefined
                );
            return type;
        }
        return undefined;
    };
    const evaluate = Effect.fnUntraced(function* (
        e: Expression,
        locals: Scope = new Map()
    ): Effect.fn.Return<Uncertain<unknown>, BackendError> {
        switch (e.kind) {
            case "literal":
                return certain(e.value.value);
            case "inputReference":
                return options.knownInputs && !options.knownInputs.has(e.value.name)
                    ? uncertain()
                    : certain(input[e.value.name]);
            case "contextReference": {
                if (Object.hasOwn(context, e.value.name)) return certain(context[e.value.name]);
                const shape = resolve(ir.context?.type);
                let type =
                    shape?.kind === "struct"
                        ? shape.value.fields.find((f) => f.name === e.value.name)?.type
                        : undefined;
                const seen = new Set<string>();
                while (type?.kind === "ref" && !seen.has(type.value.name)) {
                    const name = type.value.name;
                    seen.add(name);
                    type = ir.types.find((t) => t.name === name)?.type;
                }
                return type?.kind === "optional" ? certain(undefined) : uncertain();
            }
            case "localReference":
                return locals.has(e.value.name) ? certain(locals.get(e.value.name)) : uncertain();
            case "getAt": {
                const value = yield* evaluate(e.value.source, locals);
                if (!value.certain) return value;
                let current = value.value;
                for (const property of e.value.path) {
                    if (current !== null && typeof current === "object") {
                        const entity = rowEntities.get(current);
                        if (entity && options.canReadProperty && !options.canReadProperty(entity, property))
                            return uncertain();
                        current = Object.hasOwn(current, property)
                            ? Reflect.get(current, property)
                            : undefined;
                    } else current = undefined;
                }
                return certain(current);
            }
            case "case": {
                for (const branch of e.value.branches) {
                    const c = yield* evaluate(branch.condition, locals);
                    if (!c.certain) return uncertain();
                    if (yield* attempt(() => booleanValue(c.value)))
                        return yield* evaluate(branch.result, locals);
                }
                return yield* evaluate(e.value.else, locals);
            }
            case "exists": {
                const rows = yield* queryRows(
                    {
                        ...e.value.query,
                        page: { ...e.value.query.page, limit: e.value.query.page?.limit === 0 ? 0 : 1 },
                    },
                    locals
                );
                return certain(rows.length > 0);
            }
            case "struct": {
                const result: Record<string, unknown> = Object.create(null);
                for (const f of e.value.fields) {
                    const v = yield* evaluate(f.value, locals);
                    if (!v.certain) return uncertain();
                    result[f.name] = v.value;
                }
                return certain(result);
            }
            case "map": {
                const list = yield* evaluate(e.value.source, locals);
                if (!list.certain || list.value === undefined) return list;
                if (!Array.isArray(list.value)) return yield* fail("Map source must be a list.");
                const result: unknown[] = [];
                for (const item of list.value) {
                    const value = yield* evaluate(
                        e.value.body,
                        new Map([...locals, [e.value.binding, item]])
                    );
                    if (!value.certain) return uncertain();
                    result.push(value.value);
                }
                return certain(result);
            }
            case "objectLookup": {
                const key = yield* evaluate(e.value.reference, locals);
                if (!key.certain || key.value == null) return key;
                const type = referenceType(e.value.reference);
                if (type?.kind !== "objectReference")
                    return yield* fail("Lookup requires a typed object reference.");
                const object = ir.objectTypes.find((t) => t.name === type.value.objectType)!;
                const rows = yield* fetch(
                    { objectType: object.name },
                    { where: eq(field(object.primaryKey), key.value as Scalar), limit: 2 }
                );
                if (rows.length > 1)
                    return yield* fail("Object lookup returned multiple identities.", "InvalidResponse");
                return certain(rows[0]?.value);
            }
            case "related": {
                const owner = yield* evaluate(e.value.source, locals);
                if (!owner.certain || owner.value == null) return owner;
                const entity = typeof owner.value === "object" && rowEntities.get(owner.value);
                if (!entity) return yield* fail("Relationship source must be an ontology entity.");
                const reader = entity.source ? options.sources![entity.source]! : options.reader;
                const link = resolveRelatedLink(reader.ir, entity.objectType, e.value.link);
                if (!link) return yield* fail("Unknown relationship.");
                const ownFK = isRelatedFromForeignKeySource(link, entity.objectType, e.value.link);
                const target = reader.ir.objectTypes.find(
                    (t) => t.name === (ownFK ? link.target.objectType : link.source.objectType)
                )!;
                const key = ownFK ? readField(owner.value, field(...link.foreignKey.split("."))) : entity.key;
                if (key == null) return certain(!ownFK && link.cardinality === "many" ? [] : undefined);
                const rows = yield* fetch(
                    { ontology: entity.source, objectType: target.name },
                    {
                        where: eq(
                            ownFK ? field(target.primaryKey) : field(...link.foreignKey.split(".")),
                            key as Scalar
                        ),
                    }
                );
                if (!ownFK && link.cardinality === "many") return certain(rows.map((r) => r.value));
                if (rows.length > 1)
                    return yield* fail("To-one relationship returned multiple rows.", "InvalidResponse");
                return certain(rows[0]?.value);
            }
            case "uuid":
            case "now":
                return yield* fail("Non-deterministic expressions require an action execution context.");
            default: {
                const nodes =
                    e.kind === "not"
                        ? [e.value.expression]
                        : "expressions" in e.value
                          ? e.value.expressions
                          : [e.value.left, e.value.right];
                const values: Uncertain<unknown>[] = [];
                for (const node of nodes) {
                    const v = yield* evaluate(node, locals);
                    values.push(v);
                    if (
                        (e.kind === "and" || e.kind === "or") &&
                        v.certain &&
                        (yield* attempt(() => booleanValue(v.value))) === (e.kind === "or")
                    )
                        break;
                    if (e.kind === "coalesce" && (!v.certain || v.value != null)) break;
                }
                return yield* attempt(() => evaluateOperator(e.kind, values));
            }
        }
    });
    const lower = Effect.fnUntraced(function* (
        e: Expression,
        binding: string,
        locals: Scope
    ): Effect.fn.Return<{ where?: Predicate; exact: boolean }, BackendError> {
        if (e.kind === "and" || e.kind === "or") {
            const values = [];
            for (const expression of e.value.expressions)
                values.push(yield* lower(expression, binding, locals));
            if (e.kind === "or" && values.some((v) => !v.exact)) return { exact: false };
            return {
                where:
                    e.kind === "and"
                        ? and(...values.flatMap((v) => (v.where ? [v.where] : [])))
                        : or(...values.flatMap((v) => (v.where ? [v.where] : []))),
                exact: values.every((v) => v.exact),
            };
        }
        if (e.kind === "not") {
            const v = yield* lower(e.value.expression, binding, locals);
            return v.exact && v.where ? { where: not(v.where), exact: true } : { exact: false };
        }
        if (
            !("left" in e.value) ||
            !["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains", "like", "ilike"].includes(e.kind)
        )
            return { exact: false };
        const operand = Effect.fnUntraced(function* (
            node: Expression
        ): Effect.fn.Return<Operand | { unknown: true }, BackendError> {
            if (
                node.kind === "getAt" &&
                node.value.source.kind === "localReference" &&
                node.value.source.value.name === binding
            )
                return field(...node.value.path);
            const value = yield* evaluate(node, locals);
            if (!value.certain) return { unknown: true };
            try {
                scalarKey(value.value);
                return value.value as Scalar;
            } catch {
                return { unknown: true };
            }
        });
        const a = yield* operand(e.value.left);
        if (a && typeof a === "object" && "unknown" in a) return { exact: false };
        if (e.kind === "in") {
            const b = yield* evaluate(e.value.right, locals);
            if (!b.certain || !Array.isArray(b.value)) return { exact: false };
            try {
                b.value.forEach(scalarKey);
            } catch {
                return { exact: false };
            }
            return { where: inArray(a as Operand, b.value as Scalar[]), exact: true };
        }
        const b = yield* operand(e.value.right);
        if (b && typeof b === "object" && "unknown" in b) return { exact: false };
        if (e.kind === "eq" || e.kind === "ne")
            return {
                where: e.kind === "eq" ? eq(a as Operand, b as Operand) : ne(a as Operand, b as Operand),
                exact: true,
            };
        if (e.kind === "contains" && a && typeof a === "object" && "_tag" in a)
            return { where: contains(a, b as Operand), exact: true };
        if ((e.kind === "like" || e.kind === "ilike") && typeof b === "string")
            return { where: (e.kind === "like" ? like : ilike)(a as Operand, b), exact: true };
        if (["lt", "lte", "gt", "gte"].includes(e.kind))
            return {
                where: and(
                    ne(a as Operand, undefined),
                    ne(a as Operand, null),
                    ne(b as Operand, undefined),
                    ne(b as Operand, null),
                    { op: e.kind as "lt", left: a as Operand, right: b as Operand }
                ),
                exact: true,
            };
        return { exact: false };
    });
    const queryRows = Effect.fnUntraced(function* (
        q: Query,
        parent: Scope
    ): Effect.fn.Return<
        { row: Row<Record<string, unknown>>; scope: Scope; order: unknown[] }[],
        BackendError
    > {
        const candidate =
            options.strategy === "reference"
                ? { exact: false }
                : q.where
                  ? yield* lower(q.where, q.from.binding, parent)
                  : { exact: true };
        const directOrder =
            q.orderBy?.every(
                (o) =>
                    o.expression.kind === "getAt" &&
                    o.expression.value.source.kind === "localReference" &&
                    o.expression.value.source.value.name === q.from.binding
            ) ?? true;
        let scan: Scan = { where: candidate.where };
        if (directOrder)
            scan = {
                ...scan,
                orderBy: q.orderBy?.map((o) => ({
                    field: field(...(o.expression as Extract<Expression, { kind: "getAt" }>).value.path),
                    direction: o.direction,
                    nulls: o.nulls,
                })),
            };
        const pushedPage = candidate.exact && directOrder && !options.canReadProperty;
        if (pushedPage) Object.assign(scan, q.page);
        const rows = yield* fetch(q.from.source, scan);
        const accepted: { row: Row<Record<string, unknown>>; scope: Scope; order: unknown[] }[] = [];
        for (const row of rows) {
            const scope = new Map([...parent, [q.from.binding, row.value]]);
            if (q.where) {
                const test = yield* evaluate(q.where, scope);
                if (!test.certain)
                    return yield* fail("A query filter depends on unavailable data.", "Forbidden");
                if (!(yield* attempt(() => booleanValue(test.value)))) continue;
            }
            const order: unknown[] = [];
            for (const o of q.orderBy ?? []) {
                const value = yield* evaluate(o.expression, scope);
                if (!value.certain) return yield* fail("Ordering depends on unavailable data.", "Forbidden");
                order.push(value.value);
            }
            accepted.push({ row, scope, order });
        }
        const compare = (left: unknown[], leftKey: unknown, right: unknown[], rightKey: unknown): number => {
            for (const [i, order] of (q.orderBy ?? []).entries()) {
                const x = left[i],
                    y = right[i];
                if (order.nulls && (x == null || y == null)) {
                    if (x == null && y == null) continue;
                    return (x == null ? -1 : 1) * (order.nulls === "first" ? 1 : -1);
                }
                const c = compareScalar(x, y);
                if (c) return c * (order.direction === "desc" ? -1 : 1);
            }
            return compareScalar(leftKey, rightKey);
        };
        yield* attempt(() => accepted.sort((a, b) => compare(a.order, a.row.key, b.order, b.row.key)));
        if (pushedPage) return accepted;
        const after = q.page?.after;
        const filtered = after
            ? yield* attempt(() =>
                  accepted.filter((a) => compare(a.order, a.row.key, after.values, after.key) > 0)
              )
            : accepted;
        return filtered.slice(
            q.page?.offset ?? 0,
            q.page?.limit === undefined ? undefined : (q.page.offset ?? 0) + q.page.limit
        );
    });
    const select = Effect.fnUntraced(function* (
        items: readonly QuerySelection[],
        scope: Scope
    ): Effect.fn.Return<Record<string, unknown>, BackendError> {
        const output: Record<string, unknown> = Object.create(null);
        for (const item of items) {
            if (item.kind === "selectCase") {
                let selected = item.value.else ?? [];
                for (const b of item.value.branches) {
                    const c = yield* evaluate(b.condition, scope);
                    if (!c.certain) return yield* fail("A selection condition is not known.", "Forbidden");
                    if (yield* attempt(() => booleanValue(c.value))) {
                        selected = b.select;
                        break;
                    }
                }
                Object.assign(output, yield* select(selected, scope));
            } else if (item.kind === "sub") {
                const rows = yield* queryRows(item.value.query, scope);
                if (item.value.cardinality === "one" && rows.length > 1)
                    return yield* fail("A singular subquery returned multiple rows.");
                const values = [];
                for (const row of rows) {
                    if (options.mode === "entity") {
                        const entity = rowEntities.get(row.row.value)!;
                        const reader = source(item.value.query.from.source);
                        const id = JSON.stringify([entity.source ?? "", entity.objectType, entity.key]);
                        const grant = grants.get(id) ?? {
                            ...entity,
                            properties: new Set([
                                reader.ir.objectTypes.find((t) => t.name === entity.objectType)!.primaryKey,
                            ]),
                        };
                        grants.set(id, grant);
                    }
                    values.push(yield* select(item.value.query.select, row.scope));
                }
                output[item.value.name] = item.value.cardinality === "one" ? values[0] : values;
            } else {
                const value = yield* evaluate(item.value.expression, scope);
                if (value.certain) output[item.value.name] = value.value;
                if (options.mode === "entity") {
                    const property = selectedProperty(item.value.expression);
                    const entity = property && rowEntities.get(scope.get(property.binding) as object);
                    if (entity) {
                        const id = JSON.stringify([entity.source ?? "", entity.objectType, entity.key]);
                        const grant = grants.get(id) ?? { ...entity, properties: new Set<string>() };
                        grant.properties.add(property!.property);
                        grants.set(id, grant);
                    }
                }
            }
        }
        return output;
    });
    return {
        evaluate,
        lower,
        run: Effect.fnUntraced(function* (document: QueryDocument) {
            const issues = validateQueryDocument(ir, document, {
                mode: options.mode,
                inputs: options.inputDefinitions,
                sources:
                    options.sources &&
                    Object.fromEntries(Object.entries(options.sources).map(([k, v]) => [k, v.ir])),
            });
            if (issues.length)
                return yield* new BackendError({
                    operation: "query",
                    kind: "InvalidRequest",
                    message: "Invalid query definition.",
                    issues,
                    retryable: false,
                });
            const value = yield* select(document.select, new Map());
            return { value, entities: [...grants.values()] };
        }),
    };
}
export const executeQuery = Effect.fn("Query.execute")(function* (
    document: QueryDocument,
    options: QueryExecutionOptions
) {
    // Infrastructure schemas validate values; query IR validation checks their use.
    let name = "QueryInputs";
    while ([...options.reader.ir.types, ...options.reader.ir.objectTypes].some((type) => type.name === name))
        name += "_";
    const schemas = yield* attempt(() =>
        compileEffectSchemas({
            ...options.reader.ir,
            types: [
                ...options.reader.ir.types,
                {
                    name,
                    type: {
                        kind: "struct",
                        value: { fields: [...(options.inputDefinitions ?? document.inputs ?? [])] },
                    },
                },
            ],
        })
    );
    const inputs = yield* Schema.decodeUnknownEffect(Schema.toEncoded(schemas.namedSchemas[name]!))(
        options.inputs ?? {}
    ).pipe(Effect.mapError(() => fail("Query inputs do not match their definition.")));
    return yield* queryExecutor({
        ...options,
        inputs: inputs as Record<string, unknown>,
        inputDefinitions: options.inputDefinitions ?? document.inputs,
    }).run(document);
});
