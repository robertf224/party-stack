import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { Effect, Predicate, Schema } from "effect";
import { configurationError, type OntologyStorageError } from "../errors.js";
import { Table, type Key } from "../model.js";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology-spec";

export type ObjectCodecs = Readonly<
    Record<string, Schema.Codec<Record<string, unknown>, Record<string, unknown>>>
>;
const ObjectTypeId: unique symbol = Symbol("OntologyObjectStore");
const StorageModelId: unique symbol = Symbol("OntologyStorageModel");
export interface ObjectStore<A, K extends Key = Key> {
    readonly name: string;
    readonly definition: ObjectTypeDef;
    readonly [ObjectTypeId]: { readonly value: A; readonly key: K };
}
export interface StorageModel<Objects = Readonly<Record<string, ObjectStore<unknown>>>> {
    readonly namespace: string;
    readonly objects: Objects;
    readonly [StorageModelId]: true;
}
type PrimaryKey<IR extends OntologyIR, N extends string> =
    Extract<IR["objectTypes"][number], { name: N }> extends { primaryKey: infer P extends string }
        ? P
        : string;
type ObjectKey<IR extends OntologyIR, N extends string, A> =
    string extends PrimaryKey<IR, N> ? Key : A[PrimaryKey<IR, N> & keyof A] & Key;
type ObjectsFor<IR extends OntologyIR, C extends ObjectCodecs> = {
    readonly [N in keyof C & string]: ObjectStore<C[N]["Type"], ObjectKey<IR, N, C[N]["Type"]>>;
};
export interface CompiledObject {
    readonly table: Table<Record<string, unknown>>;
    readonly key: (input: unknown) => Key;
    readonly encode: (value: unknown) => Record<string, unknown>;
    readonly decode: (value: unknown) => Record<string, unknown>;
}
export interface CompiledModel {
    readonly signature: string;
    readonly stamp: Table<{ signature: string }>;
    readonly ir: OntologyIR;
    readonly stores: ReadonlyMap<ObjectStore<unknown>, CompiledObject>;
}
const compiled = new WeakMap<StorageModel, CompiledModel>();
export function compiledModel(model: StorageModel): CompiledModel {
    const result = compiled.get(model);
    if (!result) throw new TypeError("Use makeStorageModel to construct a storage model.");
    return result;
}

// Presentation changes do not change storage identity. Keep all type constraints.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function typeIdentity(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(typeIdentity).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    if (Predicate.isObject(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .filter(
                    ([key]) =>
                        ![
                            "description",
                            "deprecated",
                            "displayName",
                            "pluralDisplayName",
                            "label",
                            "icon",
                            "meta",
                            "suggestions",
                        ].includes(key)
                )
                .sort(([a], [b]) => compare(a, b))
                .map(([key, entry]) => [key, typeIdentity(entry)])
        );
    }
    return value;
}
function primaryKeySchema(ir: OntologyIR, type: TypeDef, seen = new Set<string>()): Schema.Codec<Key> {
    if (type.kind === "string") {
        const constraint = type.value.constraint;
        if (constraint?.kind === "enum")
            return Schema.Literals(constraint.value.options.map((option) => option.value));
        if (constraint?.kind === "regex")
            return Schema.String.check(Schema.isPattern(new RegExp(constraint.value.regex)));
        return Schema.String;
    }
    if (type.kind === "integer") return Schema.Number.check(Schema.isInt32());
    if (type.kind === "float" || type.kind === "double") return Schema.Finite;
    let target: TypeDef | undefined;
    const name =
        type.kind === "ref"
            ? `type:${type.value.name}`
            : type.kind === "objectReference"
              ? `object:${type.value.objectType}`
              : undefined;
    if (name === undefined || seen.has(name))
        throw new TypeError("Ontology primary keys must resolve to required strings or numbers.");
    if (type.kind === "ref") target = ir.types.find((candidate) => candidate.name === type.value.name)?.type;
    if (type.kind === "objectReference") {
        const object = ir.objectTypes.find((candidate) => candidate.name === type.value.objectType);
        target = object?.properties.find((property) => property.name === object.primaryKey)?.type;
    }
    if (!target) throw new TypeError("Unresolved primary key type.");
    return primaryKeySchema(ir, target, new Set([...seen, name]));
}
function freezeDefinition(value: unknown, seen = new WeakSet<object>()): void {
    if (!Predicate.isObjectOrArray(value) || seen.has(value)) return;
    seen.add(value);
    for (const entry of Object.values(value)) freezeDefinition(entry, seen);
    Object.freeze(value);
}
const Stamp = Schema.Struct({ signature: Schema.String });

/** Derive runtime codecs or bind generated codecs to the existing ontology definitions. */
export const makeStorageModel = Effect.fnUntraced(function* <
    const IR extends OntologyIR,
    const C extends ObjectCodecs = ObjectCodecs,
>(options: {
    readonly namespace: string;
    readonly ir: IR;
    readonly schemas?: C & Record<IR["objectTypes"][number]["name"], ObjectCodecs[string]>;
}): Effect.fn.Return<StorageModel<ObjectsFor<IR, C>>, OntologyStorageError> {
    return yield* Effect.try({
        try: () => {
            if (!options.namespace) throw new TypeError("Storage requires a nonempty namespace.");
            // Copy descriptive definitions so subsequent application mutation cannot alter the model.
            const ir = structuredClone(options.ir);
            freezeDefinition(ir);
            const schemas = options.schemas ?? compileEffectSchemas(ir).objectSchemas;
            const names = new Set(ir.objectTypes.map((object) => object.name));
            if (names.size !== ir.objectTypes.length) throw new TypeError("Duplicate object type names.");
            if (
                Object.keys(schemas).length !== names.size ||
                Object.keys(schemas).some((name) => !names.has(name))
            )
                throw new TypeError("Object codecs must match the ontology object types exactly.");
            const stores = new Map<ObjectStore<unknown>, CompiledObject>();
            const objects = Object.fromEntries(
                ir.objectTypes.map((definition) => {
                    const schema = schemas[definition.name];
                    if (!schema) throw new TypeError(`Missing codec for ${definition.name}.`);
                    const primaryKey = definition.properties.find(
                        (property) => property.name === definition.primaryKey
                    );
                    if (!primaryKey)
                        throw new TypeError(`Missing primary key property for ${definition.name}.`);
                    const key = Schema.decodeUnknownSync(primaryKeySchema(ir, primaryKey.type));
                    const core = Schema.decodeUnknownSync(Schema.toEncoded(schema));
                    const object = Object.freeze({
                        name: definition.name,
                        definition,
                        [ObjectTypeId]: undefined,
                    }) as unknown as ObjectStore<unknown>;
                    stores.set(object, {
                        key,
                        table: Table.make({
                            name: JSON.stringify(["ontology", options.namespace, "object", definition.name]),
                            codec: { encode: core, decode: core },
                        }),
                        encode: Schema.encodeUnknownSync(schema),
                        decode: Schema.decodeUnknownSync(schema),
                    });
                    return [definition.name, object];
                })
            );
            const model = Object.freeze({
                namespace: options.namespace,
                objects: Object.freeze(objects),
                [StorageModelId]: true as const,
            });
            const signature = JSON.stringify(
                typeIdentity({
                    types: ir.types.map(({ name, type }) => ({ name, type })),
                    objects: ir.objectTypes.map(({ name, primaryKey, properties }) => ({
                        name,
                        primaryKey,
                        properties: properties.map(({ name, type }) => ({ name, type })),
                    })),
                })
            );
            const stamp = Table.make({
                name: JSON.stringify(["ontology", options.namespace, "model"]),
                codec: { encode: Schema.encodeSync(Stamp), decode: Schema.decodeUnknownSync(Stamp) },
            });
            compiled.set(model, { ir, stores, signature, stamp });
            return model as StorageModel<ObjectsFor<IR, C>>;
        },
        catch: (cause) => configurationError("model", cause instanceof Error ? cause.message : String(cause)),
    });
});
