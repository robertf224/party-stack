import {
    applyLensToObject,
    applyLensToObjectType,
    applyLensPatchToObject,
    mapTargetPathToSourceWithLens,
    type Lens,
    type ObjectTypeDef,
    type OntologyIR,
    type TypeDef,
} from "@party-stack/ontology-spec";
import {
    field,
    type Query,
    type Predicate,
    type Operand,
    type Field,
    type Index,
    type Row,
} from "@party-stack/ontology-storage";
import { Effect, Schema } from "effect";
import { fieldType, type AuthRow } from "./model.js";
import type { OwnedReadTransaction, OwnedStorageTransaction } from "@party-stack/ontology-backend/owned";
import type { getAuthTables } from "better-auth/db";

/** The source is application-owned; the lens presents Better Auth's logical fields. */
export interface AuthModelView {
    readonly objectType: string;
    readonly lens: Lens;
    /** Source-side values for application fields that Better Auth cannot supply on creation. */
    readonly defaults?: Readonly<Record<string, unknown>>;
}
export interface AuthObject {
    readonly name: string;
    readonly definition: ObjectTypeDef;
}
export interface AuthTransaction {
    readonly get: (object: AuthObject, key: string) => Effect.Effect<AuthRow | undefined, unknown>;
    readonly loadSubset: (object: AuthObject, query?: Query) => Effect.Effect<Row<AuthRow>[], unknown>;
    readonly put: (object: AuthObject, value: AuthRow) => Effect.Effect<void, unknown>;
    readonly delete: (object: AuthObject, key: string) => Effect.Effect<void, unknown>;
    readonly ensureIndex: (object: AuthObject, index: Index) => Effect.Effect<void, unknown>;
}
const isField = Schema.is(
    Schema.Struct({ _tag: Schema.Literal("Field"), path: Schema.Array(Schema.String) })
);

function compatible(ir: OntologyIR, actual: TypeDef, expected: TypeDef, seen = new Set<string>()): boolean {
    if (expected.kind === "unknown") return true;
    if (actual.kind === "optional") return compatible(ir, actual.value.type, expected, seen);
    if (actual.kind === "ref" || actual.kind === "objectReference") {
        const name =
            actual.kind === "ref" ? `type:${actual.value.name}` : `object:${actual.value.objectType}`;
        if (seen.has(name)) return false;
        const object =
            actual.kind === "objectReference"
                ? ir.objectTypes.find((o) => o.name === actual.value.objectType)
                : undefined;
        const target =
            actual.kind === "ref"
                ? ir.types.find((t) => t.name === actual.value.name)?.type
                : object?.properties.find((p) => p.name === object.primaryKey)?.type;
        return target !== undefined && compatible(ir, target, expected, new Set([...seen, name]));
    }
    if (actual.kind === "list" && expected.kind === "list")
        return compatible(ir, actual.value.elementType, expected.value.elementType, seen);
    return (
        actual.kind === expected.kind ||
        (expected.kind === "double" && ["integer", "float"].includes(actual.kind))
    );
}

export function compileAuthViews(
    ir: OntologyIR,
    models: Readonly<Record<string, AuthModelView>>,
    logical: ReturnType<typeof getAuthTables>
) {
    const views = new Map<
        string,
        {
            object: AuthObject;
            source: ObjectTypeDef;
            config: AuthModelView;
            path: (path: readonly string[]) => string[];
            read: (row: Record<string, unknown>) => AuthRow;
            write: (source: Record<string, unknown>, patch: AuthRow) => Record<string, unknown>;
        }
    >();
    const used = new Set<string>();
    for (const [logicalName, table] of Object.entries(logical)) {
        const authored = models[logicalName];
        if (!authored) throw new TypeError(`Missing Better Auth lens for model "${logicalName}".`);
        const config = {
            ...authored,
            lens: structuredClone(authored.lens),
            defaults: applyLensToObject(authored.defaults ?? {}, { operations: [] }),
        };
        const source = ir.objectTypes.find((object) => object.name === config.objectType);
        if (!source) throw new TypeError(`Unknown ontology object type for "${logicalName}".`);
        if (used.has(source.name))
            throw new TypeError("Each auth model needs a distinct source object type.");
        used.add(source.name);
        const projected = applyLensToObjectType(source, config.lens, { name: table.modelName });
        if (projected.primaryKey !== "id")
            throw new TypeError(`Auth lens for "${logicalName}" must expose id as its primary key.`);
        const aliases = new Map<string, string>([
            ["id", "id"],
            ...Object.entries(table.fields).map(([name, attr]) => [name, attr.fieldName ?? name] as const),
        ]);
        for (const [name, attribute] of Object.entries({
            id: { type: "string" as const },
            ...table.fields,
        })) {
            const property = projected.properties.find((field) => field.name === name);
            if (!property) throw new TypeError(`Auth lens for "${logicalName}" does not expose "${name}".`);
            if (!compatible(ir, property.type, fieldType(attribute)))
                throw new TypeError(`Incompatible ontology type for auth field "${logicalName}.${name}".`);
        }
        if (new Set(aliases.values()).size !== aliases.size)
            throw new TypeError(`Duplicate field aliases for auth model "${logicalName}".`);
        const path = (input: readonly string[]) => {
            const name = [...aliases].find(([, physical]) => physical === input[0])?.[0];
            if (!name) throw new TypeError("Unknown auth view field.");
            return mapTargetPathToSourceWithLens([name, ...input.slice(1)], config.lens);
        };
        const definition = {
            ...projected,
            properties: projected.properties
                .filter((p) => aliases.has(p.name))
                .map((p) => ({ ...p, name: aliases.get(p.name)! })),
        };
        const object = { name: table.modelName, definition };
        views.set(table.modelName, {
            object,
            source,
            config,
            path,
            read: (row) => {
                const projected = applyLensToObject(row, config.lens);
                return Object.fromEntries(
                    [...aliases].map(([name, physical]) => [physical, projected[name]])
                ) as AuthRow;
            },
            write: (source, patch) =>
                applyLensPatchToObject(
                    source,
                    Object.fromEntries(
                        Object.entries(patch).map(([physical, value]) => {
                            const name = [...aliases].find(([, target]) => target === physical)?.[0];
                            if (!name) throw new TypeError("Unknown auth view field.");
                            return [name, value];
                        })
                    ),
                    config.lens
                ),
        });
    }
    const object = (name: string): AuthObject => {
        const view = views.get(name);
        if (!view) throw new TypeError("Unknown auth model.");
        return view.object;
    };
    return {
        object,
        bind: (tx: OwnedReadTransaction | OwnedStorageTransaction): AuthTransaction => {
            const viewFor = (object: AuthObject) => {
                const view = views.get(object.name);
                if (!view || view.object !== object) throw new TypeError("Unknown auth view.");
                return {
                    ...view,
                    store: view.source.name,
                };
            };
            const remap = (operand: Operand, path: (path: readonly string[]) => string[]): Operand =>
                isField(operand) ? field(...path(operand.path)) : operand;
            const predicate = (value: Predicate, path: (path: readonly string[]) => string[]): Predicate => {
                switch (value.op) {
                    case "and":
                    case "or":
                        return { ...value, predicates: value.predicates.map((p) => predicate(p, path)) };
                    case "not":
                        return { ...value, predicate: predicate(value.predicate, path) };
                    case "in":
                        return { ...value, left: remap(value.left, path) };
                    case "contains":
                        return {
                            ...value,
                            left: field(...path(value.left.path)),
                            right: remap(value.right, path),
                        };
                    case "like":
                    case "ilike":
                        return {
                            ...value,
                            left: remap(value.left, path),
                            right: isField(value.right) ? field(...path(value.right.path)) : value.right,
                        };
                    default:
                        return { ...value, left: remap(value.left, path), right: remap(value.right, path) };
                }
            };
            const attempt = <A>(work: () => A) => Effect.try({ try: work, catch: (cause) => cause });
            return {
                get: Effect.fnUntraced(function* (object, key) {
                    const view = yield* attempt(() => viewFor(object));
                    const row = yield* tx.get(view.store, key);
                    return row === undefined ? undefined : yield* attempt(() => view.read(row));
                }),
                loadSubset: Effect.fnUntraced(function* (object, query = {}) {
                    const view = yield* attempt(() => viewFor(object));
                    const rewritten = yield* attempt(() => ({
                        ...query,
                        where: query.where ? predicate(query.where, view.path) : undefined,
                        orderBy: query.orderBy?.map((order) => ({
                            ...order,
                            field: field(...view.path(order.field.path)),
                        })),
                    }));
                    const rows = yield* tx.loadSubset(view.store, rewritten);
                    return yield* attempt(() =>
                        rows.map((row) => ({ key: row.key, value: view.read(row.value) }))
                    );
                }),
                put: Effect.fnUntraced(function* (object, patch) {
                    const view = yield* attempt(() => viewFor(object));
                    const existing = yield* tx.get(view.store, patch.id);
                    const source = yield* attempt(() =>
                        view.write(existing ?? { ...view.config.defaults }, patch)
                    );
                    yield* (tx as OwnedStorageTransaction).put(view.store, source);
                }),
                delete: (object, key) =>
                    Effect.flatMap(
                        attempt(() => viewFor(object)),
                        (view) => (tx as OwnedStorageTransaction).delete(view.store, key)
                    ),
                ensureIndex: (object, index) =>
                    Effect.flatMap(
                        attempt(() => {
                            const view = viewFor(object);
                            return {
                                store: view.store,
                                index: {
                                    ...index,
                                    name: `better-auth:${object.name}:${index.name}`,
                                    field: field(...view.path(index.field.path)) as Field,
                                },
                            };
                        }),
                        ({ store, index }) => (tx as OwnedStorageTransaction).ensureIndex(store, index)
                    ),
            };
        },
    };
}
