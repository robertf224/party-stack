import { Schema } from "effect";
import { ImageMediaTypeOptions } from "../ir/generated/constants.js";
import { Encrypted, Result, TemporalDate, TemporalTimestamp } from "./codecs.js";
import type { FieldDef, OntologyIR, TypeDef } from "../ir/generated/types.js";

type ValueCodec = Schema.Codec<unknown, unknown>;
type ObjectCodec = Schema.Codec<Record<string, unknown>, Record<string, unknown>>;

export interface CompiledEffectSchemas {
    readonly namedSchemas: Readonly<Record<string, ValueCodec>>;
    readonly objectSchemas: Readonly<Record<string, ObjectCodec>>;
    readonly actionParameterSchemas: Readonly<Record<string, ObjectCodec>>;
    readonly queryParameterSchemas: Readonly<Record<string, ObjectCodec>>;
    readonly queryReturnSchemas: Readonly<Record<string, ValueCodec>>;
}

/**
 * Construct codecs directly from runtime IR, without evaluating generated code.
 * Like Schema constructors, invalid definitions throw during setup. Generated
 * codecs additionally supply named static TypeScript types.
 */
export function compileEffectSchemas(source: OntologyIR): CompiledEffectSchemas {
    // Lazy references must not observe later edits to the caller's definitions.
    const ir = structuredClone(source);
    const objects = new Map(ir.objectTypes.map((object) => [object.name, object]));
    const definitions = new Map<string, TypeDef>();
    const schemas = new Map<string, ValueCodec>();
    const rendered = new Map<string, ValueCodec>();
    const add = (name: string, type: TypeDef) => {
        if (definitions.has(name)) throw new TypeError(`Duplicate ontology schema ${JSON.stringify(name)}.`);
        definitions.set(name, type);
        schemas.set(
            name,
            Schema.suspend(() => rendered.get(name)!)
        );
    };
    for (const type of ir.types) add(type.name, type.type);
    for (const object of ir.objectTypes)
        add(object.name, { kind: "struct", value: { fields: object.properties } });

    const stringSchema = (type: Extract<TypeDef, { kind: "string" }>) => {
        const constraint = type.value.constraint;
        if (constraint?.kind === "enum")
            return Schema.Literals(constraint.value.options.map((option) => option.value));
        if (constraint?.kind === "regex")
            return Schema.String.check(Schema.isPattern(new RegExp(constraint.value.regex)));
        return Schema.String;
    };
    const struct = (fields: readonly FieldDef[]): ObjectCodec =>
        Schema.Struct(
            Object.fromEntries(
                fields.map((field) => [
                    field.name,
                    field.type.kind === "optional"
                        ? Schema.optional(render(field.type.value.type))
                        : render(field.type),
                ])
            )
        );
    const primaryKey = (name: string, seen: ReadonlySet<string>): ValueCodec => {
        const object = objects.get(name);
        const field = object?.properties.find((property) => property.name === object.primaryKey);
        if (!field)
            throw new TypeError(`Cannot resolve primary key for object reference ${JSON.stringify(name)}.`);
        const identity = `object:${name}`;
        if (seen.has(identity))
            throw new TypeError(`Circular object reference primary key for ${JSON.stringify(name)}.`);
        return keyType(field.type, new Set([...seen, identity]));
    };
    const keyType = (type: TypeDef, seen: ReadonlySet<string>): ValueCodec => {
        if (type.kind === "objectReference") return primaryKey(type.value.objectType, seen);
        if (type.kind === "ref") {
            const name = type.value.name;
            const definition = definitions.get(name);
            if (!definition) throw new TypeError(`Unknown ontology type ${JSON.stringify(name)}.`);
            const identity = `type:${name}`;
            if (seen.has(identity))
                throw new TypeError(`Circular object reference primary key through ${JSON.stringify(name)}.`);
            return keyType(definition, new Set([...seen, identity]));
        }
        return render(type);
    };
    const render = (type: TypeDef): ValueCodec => {
        switch (type.kind) {
            case "string":
                return stringSchema(type);
            case "boolean":
                return Schema.Boolean;
            case "integer":
                return Schema.Number.check(Schema.isInt32());
            case "float":
            case "double":
                return Schema.Finite;
            case "date":
                return TemporalDate;
            case "timestamp":
                return TemporalTimestamp;
            case "geopoint":
                return Schema.Struct({ lat: Schema.Finite, lon: Schema.Finite });
            case "unknown":
                return Schema.Unknown;
            case "list":
                return Schema.mutable(Schema.Array(render(type.value.elementType)));
            case "map": {
                if (type.value.keyType.kind !== "string")
                    throw new TypeError("Effect schema compilation currently requires string map keys.");
                return Schema.Record(stringSchema(type.value.keyType), render(type.value.valueType));
            }
            case "struct":
                return struct(type.value.fields);
            case "union":
                return Schema.Union(
                    type.value.variants.map((variant) =>
                        Schema.Struct({ kind: Schema.Literal(variant.name), value: render(variant.type) })
                    )
                );
            case "result":
                return Result(render(type.value.okType), render(type.value.errType));
            case "encrypted":
                return Encrypted(render(type.value.type));
            case "optional":
                return Schema.UndefinedOr(render(type.value.type));
            case "ref": {
                const schema = schemas.get(type.value.name);
                if (!schema) throw new TypeError(`Unknown ontology type ${JSON.stringify(type.value.name)}.`);
                return schema;
            }
            case "objectReference":
                return primaryKey(type.value.objectType, new Set());
            case "attachment": {
                const content = type.value.constraint?.content;
                return Schema.Struct({
                    id: Schema.String,
                    type: Schema.optional(
                        content?.kind === "image"
                            ? Schema.Literals(
                                  content.value.mediaTypes ??
                                      ImageMediaTypeOptions.map((option) => option.value)
                              )
                            : Schema.String
                    ),
                    source: Schema.optional(
                        Schema.Struct({
                            objectType: Schema.String,
                            primaryKey: Schema.Union([Schema.String, Schema.Finite]),
                            property: Schema.String,
                        })
                    ),
                });
            }
        }
    };
    // Render every definition eagerly so broken unused definitions fail at setup.
    for (const [name, definition] of definitions) rendered.set(name, render(definition));

    const registry = <A>(entries: Iterable<readonly [string, A]>) =>
        Object.freeze(Object.fromEntries(entries));
    const uniqueRegistry = <A>(entries: readonly (readonly [string, A])[]) => {
        if (new Set(entries.map(([name]) => name)).size !== entries.length)
            throw new TypeError("Duplicate action or query function schema name.");
        return registry(entries);
    };
    return Object.freeze({
        namedSchemas: registry(ir.types.map(({ name }) => [name, schemas.get(name)!] as const)),
        objectSchemas: registry(
            ir.objectTypes.map(({ name }) => [name, schemas.get(name)! as ObjectCodec] as const)
        ),
        actionParameterSchemas: uniqueRegistry(
            ir.actionTypes.map(
                (action) =>
                    [
                        action.name,
                        Schema.Struct(
                            Object.fromEntries(
                                action.parameters.map((parameter) => {
                                    const optional = parameter.type.kind === "optional";
                                    const base = render(
                                        parameter.type.kind === "optional"
                                            ? parameter.type.value.type
                                            : parameter.type
                                    );
                                    return [
                                        parameter.name,
                                        optional
                                            ? Schema.optional(Schema.NullOr(base))
                                            : parameter.defaultValue !== undefined
                                              ? Schema.optional(base)
                                              : base,
                                    ];
                                })
                            )
                        ),
                    ] as const
            )
        ),
        queryParameterSchemas: uniqueRegistry(
            ir.queryFunctionTypes.map((query) => [query.name, struct(query.parameters)] as const)
        ),
        queryReturnSchemas: uniqueRegistry(
            ir.queryFunctionTypes.map((query) => [query.name, render(query.returnType)] as const)
        ),
    });
}
