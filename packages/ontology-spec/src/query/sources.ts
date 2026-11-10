import { o } from "../ir/generated/builders.js";
import { isRelatedFromForeignKeySource, resolveRelatedLink } from "../utils/links.js";
import type {
    Expression,
    OntologyIR,
    Query,
    QueryDocument,
    QueryFrom,
    QuerySelection,
} from "../ir/generated/types.js";
import type { ObjectQuerySource } from "./index.js";

/** Resolve link traversal into the same source and predicate used by explicit joins. */
export function resolveQuerySource(
    ir: OntologyIR,
    from: QueryFrom,
    scope: ReadonlyMap<string, ObjectQuerySource>,
    sources?: Readonly<Record<string, OntologyIR>>
): { source: ObjectQuerySource; correlation?: Expression } {
    const { source, binding } = from;
    if (!source.related) {
        if (!source.objectType) throw new Error("Query source requires an objectType or related link.");
        return { source: { ontology: source.ontology, objectType: source.objectType } };
    }
    if (source.objectType !== undefined || source.ontology !== undefined)
        throw new Error("A related source inherits its ontology and object type from the link.");
    const relation = source.related;
    if (relation.source.kind !== "localReference")
        throw new Error("A related query source must reference an ancestor row binding.");
    const owner = scope.get(relation.source.value.name);
    if (!owner) throw new Error("Unknown ancestor row binding in related query source.");
    const schema = owner.ontology ? sources?.[owner.ontology] : ir;
    const link = schema && resolveRelatedLink(schema, owner.objectType, relation.link);
    if (!schema || !link) throw new Error("Unknown or ambiguous link in related query source.");
    const forward = isRelatedFromForeignKeySource(link, owner.objectType, relation.link);
    const targetType = forward ? link.target.objectType : link.source.objectType;
    const target = schema.objectTypes.find((type) => type.name === targetType);
    const parent = schema.objectTypes.find((type) => type.name === owner.objectType);
    if (!parent || !target) throw new Error("Unknown object type in related query source.");
    return {
        source: { ontology: owner.ontology, objectType: targetType },
        correlation: o.Expression.eq({
            left: o.Expression.getAt({
                source: o.Expression.localReference({ name: binding }),
                path: forward ? [target.primaryKey] : link.foreignKey.split("."),
            }),
            right: o.Expression.getAt({
                source: relation.source,
                path: forward ? link.foreignKey.split(".") : [parent.primaryKey],
            }),
        }),
    };
}

/** Lower a validated document before planning; literals and result selections retain their semantics. */
export function resolveQuerySources(
    ir: OntologyIR,
    document: QueryDocument,
    sources?: Readonly<Record<string, OntologyIR>>
): QueryDocument {
    type Scope = ReadonlyMap<string, ObjectQuerySource>;
    function expression(e: Expression, scope: Scope): Expression {
        const visit = (value: Expression) => expression(value, scope);
        switch (e.kind) {
            case "literal":
            case "inputReference":
            case "contextReference":
            case "localReference":
            case "uuid":
            case "now":
                return e;
            case "getAt":
            case "related":
                return { ...e, value: { ...e.value, source: visit(e.value.source) } } as Expression;
            case "lookup":
                return { ...e, value: { reference: visit(e.value.reference) } };
            case "map": {
                const inner = new Map(scope);
                inner.delete(e.value.binding);
                return {
                    ...e,
                    value: {
                        ...e.value,
                        source: visit(e.value.source),
                        body: expression(e.value.body, inner),
                    },
                };
            }
            case "struct":
                return {
                    ...e,
                    value: { fields: e.value.fields.map((f) => ({ ...f, value: visit(f.value) })) },
                };
            case "exists":
                return { ...e, value: { query: query(e.value.query, scope) } };
            case "not":
                return { ...e, value: { expression: visit(e.value.expression) } };
            case "case":
                return {
                    ...e,
                    value: {
                        branches: e.value.branches.map((b) => ({
                            condition: visit(b.condition),
                            result: visit(b.result),
                        })),
                        else: visit(e.value.else),
                    },
                };
            case "and":
            case "or":
            case "concat":
            case "coalesce":
                return { ...e, value: { expressions: e.value.expressions.map(visit) } };
            default:
                return { ...e, value: { left: visit(e.value.left), right: visit(e.value.right) } };
        }
    }
    function selections(items: QuerySelection[], scope: Scope): QuerySelection[] {
        return items.map((item) => {
            if (item.kind === "sub")
                return { ...item, value: { ...item.value, query: query(item.value.query, scope) } };
            if (item.kind === "field")
                return {
                    ...item,
                    value: { ...item.value, expression: expression(item.value.expression, scope) },
                };
            return {
                ...item,
                value: {
                    branches: item.value.branches.map((b) => ({
                        condition: expression(b.condition, scope),
                        select: selections(b.select, scope),
                    })),
                    else: item.value.else && selections(item.value.else, scope),
                },
            };
        });
    }
    function query(q: Query, parent: Scope): Query {
        const { source, correlation } = resolveQuerySource(ir, q.from, parent, sources);
        const scope = new Map([...parent, [q.from.binding, source]]);
        const where = q.where && expression(q.where, scope);
        return {
            ...q,
            from: { ...q.from, source },
            where: correlation
                ? where
                    ? o.Expression.and({ expressions: [correlation, where] })
                    : correlation
                : where,
            orderBy: q.orderBy?.map((order) => ({
                ...order,
                expression: expression(order.expression, scope),
            })),
            select: selections(q.select, scope),
        };
    }
    return { ...document, select: selections(document.select, new Map()) };
}
