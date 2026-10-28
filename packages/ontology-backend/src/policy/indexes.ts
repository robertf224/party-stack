import { indexesForQuery, field } from "@party-stack/ontology-storage";
import type { Expression, OntologyIR, Query, QuerySelection, TypeDef } from "@party-stack/ontology-spec";
import type { Index } from "@party-stack/ontology-storage";

/** Static policy dependencies keep transaction-local reads indexed without
 * creating indexes from request literals or from arbitrary dynamic paths.
 */
export function policyIndexes(ir: OntologyIR): { objectType: string; index: Index }[] {
    const indexes = new Map<string, { objectType: string; index: Index }>();
    const unwrap = (type: TypeDef, seen = new Set<string>()): TypeDef => {
        if (type.kind === "optional") return unwrap(type.value.type, seen);
        if (type.kind !== "ref") return type;
        if (seen.has(type.value.name)) return { kind: "unknown", value: {} };
        const name = type.value.name;
        const definition = ir.types.find((t) => t.name === name)?.type;
        return definition ? unwrap(definition, new Set([...seen, name])) : { kind: "unknown", value: {} };
    };
    const scalar = (type: TypeDef) =>
        ["string", "integer", "double", "float", "boolean", "date", "timestamp", "objectReference"].includes(
            unwrap(type).kind
        );
    const add = (expression: Expression, scope: Map<string, string>, elements = false) => {
        if (
            expression.kind !== "getAt" ||
            expression.value.source.kind !== "localReference" ||
            expression.value.path.length !== 1
        )
            return;
        const name = scope.get(expression.value.source.value.name);
        const object = ir.objectTypes.find((t) => t.name === name);
        const property = object?.properties.find((p) => p.name === expression.value.path[0]);
        if (!object || !property) return;
        const type = unwrap(property.type);
        if (elements ? type.kind !== "list" || !scalar(type.value.elementType) : !scalar(type)) return;
        const query = {
            where: elements
                ? { op: "contains" as const, left: field(property.name), right: undefined }
                : { op: "eq" as const, left: field(property.name), right: undefined },
        };
        for (const index of indexesForQuery(query, new Set(object.properties.map((p) => p.name))))
            indexes.set(JSON.stringify([object.name, index.name]), { objectType: object.name, index });
    };
    function expression(e: Expression, scope: Map<string, string>) {
        if (e.kind === "literal") return;
        if (e.kind === "exists") {
            query(e.value.query, scope);
            return;
        }
        if (e.kind === "getAt") {
            add(e, scope);
            expression(e.value.source, scope);
            return;
        }
        if (e.kind === "contains") add(e.value.left, scope, true);
        const visit = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            if ("kind" in value) {
                expression(value as Expression, scope);
                return;
            }
            Object.values(value).forEach((v) => (Array.isArray(v) ? v.forEach(visit) : visit(v)));
        };
        visit(e.value);
    }
    function selection(items: readonly QuerySelection[], scope: Map<string, string>) {
        for (const item of items) {
            if (item.kind === "sub") query(item.value.query, scope);
            else if (item.kind === "selectCase") {
                for (const branch of item.value.branches) {
                    expression(branch.condition, scope);
                    selection(branch.select, scope);
                }
                selection(item.value.else ?? [], scope);
            }
        }
    }
    function query(q: Query, parent: Map<string, string>) {
        if (q.from.source.ontology) return;
        const scope = new Map([...parent, [q.from.binding, q.from.source.objectType]]);
        if (q.where) expression(q.where, scope);
        q.orderBy?.forEach((order) => expression(order.expression, scope));
        selection(q.select, scope);
    }
    if (ir.policy) {
        selection(ir.policy.read.select, new Map());
        for (const action of ir.policy.actions ?? []) {
            expression(action.check, new Map());
            action.bind?.forEach((binding) => expression(binding.expression, new Map()));
            if (action.read) selection(action.read.select, new Map());
        }
        for (const fn of ir.policy.queryFunctions ?? []) {
            expression(fn.check, new Map());
            if (fn.read) selection(fn.read.select, new Map());
        }
    }
    return [...indexes.values()];
}
