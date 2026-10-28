import { o } from "../ir/generated/builders.js";
import { isRelatedFromForeignKeySource, resolveRelatedLink } from "../utils/links.js";
import type {
    Expression,
    FieldDef,
    ObjectTypeDef,
    OntologyIR,
    Query,
    QueryDocument,
    QuerySelection,
    Subset,
    TypeDef,
} from "../ir/generated/types.js";
import type { ValidationIssue } from "../utils/validation.js";

type Path = (string | number)[];
type Scope = Map<string, TypeDef>;
export interface QueryValidationOptions {
    mode?: "projection" | "entity";
    sources?: Readonly<Record<string, OntologyIR>>;
    inputs?: readonly FieldDef[];
    maxNodes?: number;
    maxDepth?: number;
}
/** A field grant names the original property, never a computed alias. */
export function selectedProperty(expression: Expression): { binding: string; property: string } | undefined {
    return expression.kind === "getAt" &&
        expression.value.source.kind === "localReference" &&
        expression.value.path.length === 1
        ? { binding: expression.value.source.value.name, property: expression.value.path[0]! }
        : undefined;
}

export function validateQueryDocument(
    ir: OntologyIR,
    document: QueryDocument,
    options: QueryValidationOptions = {}
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    let visited = 0;
    const maxNodes = options.maxNodes ?? 10_000;
    const maxDepth = options.maxDepth ?? 64;
    const issue = (message: string, path: Path) => {
        if (issues.length < 100) issues.push({ message, path });
    };
    const admit = (path: Path) => {
        if (++visited > maxNodes || path.length > maxDepth) {
            if (issues.length === 0) issue("Query exceeds its expression/depth budget.", path);
            return false;
        }
        return true;
    };
    const types = new Map(ir.types.map((t) => [t.name, t.type]));
    const unknown = o.unknown({});
    const boolean = o.boolean({});
    const resolve = (type: TypeDef, seen = new Set<string>()): TypeDef => {
        if (type.kind === "optional") return resolve(type.value.type, seen);
        if (type.kind !== "ref") return type;
        if (seen.has(type.value.name)) return unknown;
        const found = types.get(type.value.name);
        return found ? resolve(found, new Set([...seen, type.value.name])) : unknown;
    };
    const objectType = (name: string, source = ir) => source.objectTypes.find((t) => t.name === name);
    const entities = new WeakMap<object, { object: ObjectTypeDef; ir: OntologyIR }>();
    const objectValue = (object: ObjectTypeDef, source = ir): TypeDef => {
        const expand = (t: TypeDef, seen = new Set<string>()): TypeDef => {
            if (t.kind === "ref") {
                if (seen.has(t.value.name)) return unknown;
                const found = source.types.find((d) => d.name === t.value.name);
                return found ? expand(found.type, new Set([...seen, t.value.name])) : unknown;
            }
            if (t.kind === "optional") return o.optional({ type: expand(t.value.type, seen) });
            if (t.kind === "list") return o.list({ elementType: expand(t.value.elementType, seen) });
            if (t.kind === "struct")
                return o.struct({
                    fields: t.value.fields.map((f) => ({ ...f, type: expand(f.type, seen) })),
                });
            return t;
        };
        const value = o.struct({ fields: object.properties.map((f) => ({ ...f, type: expand(f.type) })) });
        entities.set(value, { object, ir: source });
        return value;
    };
    const inputs = new Map((options.inputs ?? document.inputs ?? []).map((f) => [f.name, f.type]));
    const at = (type: TypeDef, path: readonly string[]): TypeDef | undefined => {
        let value = type;
        for (const key of path) {
            const t = resolve(value);
            if (t.kind !== "struct") return undefined;
            const field = t.value.fields.find((f) => f.name === key);
            if (!field) return undefined;
            value = field.type;
        }
        return value;
    };
    const isNumeric = (type: TypeDef) =>
        ["integer", "float", "double", "unknown"].includes(resolve(type).kind);
    const identity = (type: TypeDef, seen = new Set<string>()): TypeDef => {
        const resolved = resolve(type);
        if (resolved.kind !== "objectReference") return resolved;
        if (seen.has(resolved.value.objectType)) return unknown;
        const object = objectType(resolved.value.objectType);
        const key = object?.properties.find((p) => p.name === object.primaryKey)?.type;
        return key ? identity(key, new Set([...seen, resolved.value.objectType])) : unknown;
    };
    const same = (a: TypeDef, b: TypeDef): boolean => {
        const left = resolve(a),
            right = resolve(b);
        if (left.kind === "objectReference" && right.kind === "objectReference")
            return left.value.objectType === right.value.objectType;
        if (left.kind === "list" && right.kind === "list")
            return same(left.value.elementType, right.value.elementType);
        const x = identity(a).kind,
            y = identity(b).kind;
        return x === "unknown" || y === "unknown" || x === y || (isNumeric(a) && isNumeric(b));
    };
    const expect = (type: TypeDef, kind: string, path: Path) => {
        if (![kind, "unknown"].includes(resolve(type).kind)) issue(`Expected a ${kind} expression.`, path);
    };
    function expression(e: Expression, scope: Scope, path: Path): TypeDef {
        if (!admit(path)) return unknown;
        const child = (value: Expression, key: string | number) =>
            expression(value, scope, [...path, "value", key]);
        switch (e.kind) {
            case "literal": {
                const value = e.value.value;
                return typeof value === "boolean"
                    ? boolean
                    : typeof value === "number"
                      ? o.double({})
                      : typeof value === "string"
                        ? o.string({})
                        : Array.isArray(value)
                          ? o.list({ elementType: unknown })
                          : unknown;
            }
            case "inputReference": {
                const type = inputs.get(e.value.name);
                if (!type) issue(`Unknown query input ${JSON.stringify(e.value.name)}.`, path);
                return type ?? unknown;
            }
            case "contextReference": {
                const type = ir.context?.type && at(ir.context.type, [e.value.name]);
                if (!type) issue(`Unknown context field ${JSON.stringify(e.value.name)}.`, path);
                return type ?? unknown;
            }
            case "localReference": {
                const type = scope.get(e.value.name);
                if (!type) issue(`Unknown lexical binding ${JSON.stringify(e.value.name)}.`, path);
                return type ?? unknown;
            }
            case "getAt": {
                const source = child(e.value.source, "source");
                const type = at(source, e.value.path);
                if (!type) issue(`Unknown structural property path ${JSON.stringify(e.value.path)}.`, path);
                return type ?? unknown;
            }
            case "objectLookup": {
                const source = resolve(child(e.value.reference, "reference"));
                if (source.kind !== "objectReference") {
                    issue("Object lookup requires an object reference.", path);
                    return unknown;
                }
                const object = objectType(source.value.objectType);
                if (!object) issue("Unknown lookup object type.", path);
                return object ? objectValue(object) : unknown;
            }
            case "related": {
                const sourceType = resolve(child(e.value.source, "source"));
                const entity = entities.get(sourceType);
                const owner = entity?.object;
                const link = owner && resolveRelatedLink(entity!.ir, owner.name, e.value.link);
                if (!owner || !link) {
                    issue("Unknown relationship or non-entity relationship source.", path);
                    return unknown;
                }
                const onSource = isRelatedFromForeignKeySource(link, owner.name, e.value.link);
                const target = objectType(
                    onSource ? link.target.objectType : link.source.objectType,
                    entity!.ir
                );
                return target
                    ? !onSource && link.cardinality === "many"
                        ? o.list({ elementType: objectValue(target, entity!.ir) })
                        : o.optional({ type: objectValue(target, entity!.ir) })
                    : unknown;
            }
            case "struct":
                return o.struct({
                    fields: e.value.fields.map((f, i) => ({
                        name: f.name,
                        displayName: f.name,
                        type: expression(f.value, scope, [...path, "value", "fields", i, "value"]),
                    })),
                });
            case "map": {
                const source = resolve(child(e.value.source, "source"));
                if (source.kind !== "list") {
                    issue("Map source must be a list.", path);
                    return unknown;
                }
                if (scope.has(e.value.binding))
                    issue("Map binding shadows an existing lexical binding.", path);
                return o.list({
                    elementType: expression(
                        e.value.body,
                        new Map([...scope, [e.value.binding, source.value.elementType]]),
                        [...path, "value", "body"]
                    ),
                });
            }
            case "uuid":
            case "now":
                issue("Clock and random expressions are not permitted in query plans.", path);
                return unknown;
            case "exists":
                query(e.value.query, scope, [...path, "value", "query"]);
                return boolean;
            case "not":
                expect(child(e.value.expression, "expression"), "boolean", path);
                return boolean;
            case "and":
            case "or":
                e.value.expressions.forEach((v, i) =>
                    expect(expression(v, scope, [...path, "value", "expressions", i]), "boolean", path)
                );
                return boolean;
            case "case": {
                const results = [child(e.value.else, "else")];
                e.value.branches.forEach((b, i) => {
                    expect(
                        expression(b.condition, scope, [...path, "value", "branches", i, "condition"]),
                        "boolean",
                        path
                    );
                    results.push(expression(b.result, scope, [...path, "value", "branches", i, "result"]));
                });
                if (results.some((t) => !same(results[0]!, t)))
                    issue("CASE results have incompatible types.", path);
                return results.find((t) => resolve(t).kind !== "unknown") ?? unknown;
            }
            case "concat":
            case "coalesce": {
                const values = e.value.expressions.map((v, i) =>
                    expression(v, scope, [...path, "value", "expressions", i])
                );
                if (!values.length) issue("This expression requires at least one operand.", path);
                if (e.kind === "concat") values.forEach((v) => expect(v, "string", path));
                else if (values.some((v) => !same(values[0]!, v)))
                    issue("COALESCE operands have incompatible types.", path);
                return e.kind === "concat" ? o.string({}) : (values[0] ?? unknown);
            }
            default: {
                const left = resolve(child(e.value.left, "left"));
                const right = resolve(child(e.value.right, "right"));
                if (e.kind === "in" || e.kind === "contains") {
                    const list = e.kind === "in" ? right : left;
                    const item = e.kind === "in" ? left : right;
                    if (list.kind !== "list" && list.kind !== "unknown")
                        issue("Membership requires a list operand.", path);
                    else if (list.kind === "list" && !same(list.value.elementType, item))
                        issue("Membership element types do not match.", path);
                } else if (e.kind === "like" || e.kind === "ilike") {
                    expect(left, "string", path);
                    expect(right, "string", path);
                } else if (["add", "subtract", "multiply", "divide"].includes(e.kind)) {
                    if (!isNumeric(left) || !isNumeric(right))
                        issue("Arithmetic requires numeric operands.", path);
                    return o.double({});
                } else if (!same(left, right)) issue("Comparison operands have incompatible types.", path);
                return boolean;
            }
        }
    }
    function selections(values: readonly QuerySelection[], scope: Scope, path: Path): Set<string> {
        const names = new Set<string>();
        values.forEach((s, index) => {
            const p = [...path, index];
            if (!admit(p)) return;
            let added: Set<string>;
            if (s.kind === "selectCase") {
                added = new Set();
                s.value.branches.forEach((branch, i) => {
                    expect(
                        expression(branch.condition, scope, [...p, "value", "branches", i, "condition"]),
                        "boolean",
                        p
                    );
                    for (const key of selections(branch.select, scope, [
                        ...p,
                        "value",
                        "branches",
                        i,
                        "select",
                    ]))
                        added.add(key);
                });
                for (const key of selections(s.value.else ?? [], scope, [...p, "value", "else"]))
                    added.add(key);
            } else {
                added = new Set([s.value.name]);
                if (!s.value.name || ["__proto__", "constructor", "prototype"].includes(s.value.name))
                    issue("Invalid selection name.", p);
                if (s.kind === "sub") query(s.value.query, scope, [...p, "value", "query"]);
                else {
                    expression(s.value.expression, scope, [...p, "value", "expression"]);
                    if (options.mode === "entity") {
                        const property = selectedProperty(s.value.expression);
                        if (
                            !property ||
                            property.property !== s.value.name ||
                            !entities.has(resolve(scope.get(property.binding) ?? unknown))
                        )
                            issue("Entity selections must preserve the source property name and binding.", p);
                    }
                }
            }
            for (const name of added) {
                if (names.has(name)) issue(`Duplicate selection name ${JSON.stringify(name)}.`, p);
                names.add(name);
            }
        });
        return names;
    }
    function subset(value: Subset, scope: Scope, path: Path) {
        if (value.where) expect(expression(value.where, scope, [...path, "where"]), "boolean", path);
        value.orderBy?.forEach((order, i) => {
            const type = resolve(expression(order.expression, scope, [...path, "orderBy", i, "expression"]));
            if (
                !["string", "integer", "double", "float", "boolean", "date", "timestamp", "unknown"].includes(
                    type.kind
                )
            )
                issue("Ordering requires scalar expressions.", [...path, "orderBy", i]);
        });
        for (const name of ["limit", "offset"] as const) {
            const n = value.page?.[name];
            if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
                issue("Query window values must be nonnegative safe integers.", [...path, "page", name]);
        }
        if (value.page?.after) {
            if (value.page.offset !== undefined)
                issue("Cursor and offset windows cannot be combined.", [...path, "page"]);
            if (value.page.after.values.length !== (value.orderBy?.length ?? 0))
                issue("Cursor values must match the explicit ordering.", [...path, "page", "after"]);
            if (!["string", "number"].includes(typeof value.page.after.key))
                issue("Cursor key must be a source primary key.", [...path, "page", "after", "key"]);
        }
    }
    function query(value: Query, parent: Scope, path: Path) {
        if (!admit(path)) return;
        const source = value.from.source.ontology ? options.sources?.[value.from.source.ontology] : ir;
        const object = source && objectType(value.from.source.objectType, source);
        if (!object) {
            issue("Unknown query source/object type.", [...path, "from"]);
            return;
        }
        if (!value.from.binding || parent.has(value.from.binding))
            issue("Query binding is empty or shadows an ancestor binding.", [...path, "from", "binding"]);
        const scope = new Map([...parent, [value.from.binding, objectValue(object, source)]]);
        subset(value, scope, path);
        selections(value.select, scope, [...path, "select"]);
    }
    if (
        new Set((options.inputs ?? document.inputs ?? []).map((f) => f.name)).size !==
        (options.inputs ?? document.inputs ?? []).length
    )
        issue("Duplicate query input name.", ["inputs"]);
    selections(document.select, new Map(), ["select"]);
    return issues;
}
