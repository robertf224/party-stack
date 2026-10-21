import { pascalCase } from "change-case";
import { ImageMediaTypeOptions } from "../ir/generated/constants.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";

export interface GenerateEffectSchemasOpts {
    /** Generated Effect-facing models (Result uses effect/Result). */
    typesImportPath?: string;
    /** Portable models that determine the codec's encoded representation. */
    encodedTypesImportPath?: string;
    valuesImportPath?: string;
}

/** Generate validators from the ontology IR, without loading Effect in the generator. */
export function generateEffectSchemas(ir: OntologyIR, opts: GenerateEffectSchemasOpts = {}): string {
    const schemas = new Map<string, string>();
    const objects = new Map(ir.objectTypes.map((object) => [object.name, object]));
    const named = new Set([...ir.types.map((type) => type.name), ...objects.keys()]);
    const literal = JSON.stringify;
    const union = (members: string[]) =>
        members.length === 0 ? "__Schema.Never" : `__Schema.Union([${members.join(", ")}])`;
    // Computed keys also handle __proto__ as a data field, rather than an object initializer.
    const struct = (fields: { name: string; schema: string }[]) =>
        `__Schema.Struct({${fields.map((field) => `[${literal(field.name)}]: ${field.schema}`).join(", ")}})`;
    const schemaName = (name: string) => {
        if (!/^[$A-Z_][0-9A-Z_$]*$/i.test(name)) {
            throw new Error(
                `Cannot generate an Effect schema for invalid TypeScript type name ${literal(name)}.`
            );
        }
        return `${name}Schema`;
    };

    const render = (type: TypeDef, references: ReadonlySet<string> = new Set()): string => {
        switch (type.kind) {
            case "string": {
                const constraint = type.value.constraint;
                if (constraint?.kind === "enum") {
                    return `__Schema.Literals(${literal(constraint.value.options.map((option) => option.value))})`;
                }
                if (constraint?.kind === "regex") {
                    // Validate the pattern during codegen; quote its source instead of interpolating regex syntax.
                    new RegExp(constraint.value.regex);
                    return `__Schema.String.check(__Schema.isPattern(new RegExp(${literal(constraint.value.regex)})))`;
                }
                return "__Schema.String";
            }
            case "boolean":
                return "__Schema.Boolean";
            case "integer":
                return "__Schema.Number.check(__Schema.isInt32())";
            case "float":
            case "double":
                return "__Schema.Finite";
            case "date":
                return "__Values.TemporalDate";
            case "timestamp":
                return "__Values.TemporalTimestamp";
            case "geopoint":
                return struct([
                    { name: "lat", schema: "__Schema.Finite" },
                    { name: "lon", schema: "__Schema.Finite" },
                ]);
            case "unknown":
                return "__Schema.Unknown";
            case "list":
                return `__Schema.mutable(__Schema.Array(${render(type.value.elementType, references)}))`;
            case "map":
                if (type.value.keyType.kind !== "string") {
                    throw new Error("Effect schema generation currently requires string map keys.");
                }
                return `__Schema.Record(${render(type.value.keyType, references)}, ${render(type.value.valueType, references)})`;
            case "struct":
                return struct(
                    type.value.fields.map((field) => ({
                        name: field.name,
                        schema:
                            field.type.kind === "optional"
                                ? `__Schema.optional(${render(field.type.value.type, references)})`
                                : render(field.type, references),
                    }))
                );
            case "union":
                return union(
                    type.value.variants.map((variant) =>
                        struct([
                            { name: "kind", schema: `__Schema.Literal(${literal(variant.name)})` },
                            { name: "value", schema: render(variant.type, references) },
                        ])
                    )
                );
            case "result":
                return `__Values.Result(${render(type.value.okType, references)}, ${render(type.value.errType, references)})`;
            case "encrypted":
                return `__Values.Encrypted(${render(type.value.type, references)})`;
            case "optional":
                return `__Schema.UndefinedOr(${render(type.value.type, references)})`;
            case "ref":
                if (!named.has(type.value.name))
                    throw new Error(`Unknown ontology type ${literal(type.value.name)}.`);
                return schemaName(type.value.name);
            case "objectReference": {
                const name = type.value.objectType;
                if (references.has(name))
                    throw new Error(`Circular object reference primary key for ${literal(name)}.`);
                const object = objects.get(name);
                const key = object?.properties.find((property) => property.name === object.primaryKey);
                if (!key)
                    throw new Error(`Cannot resolve primary key for object reference ${literal(name)}.`);
                return render(key.type, new Set([...references, name]));
            }
            case "attachment": {
                const content = type.value.constraint?.content;
                const mediaType =
                    content?.kind === "image"
                        ? `__Schema.Literals(${literal(content.value.mediaTypes ?? ImageMediaTypeOptions.map((option) => option.value))})`
                        : "__Schema.String";
                return struct([
                    { name: "id", schema: "__Schema.String" },
                    { name: "type", schema: `__Schema.optional(${mediaType})` },
                    {
                        name: "source",
                        schema: `__Schema.optional(${struct([
                            { name: "objectType", schema: "__Schema.String" },
                            { name: "primaryKey", schema: union(["__Schema.String", "__Schema.Finite"]) },
                            { name: "property", schema: "__Schema.String" },
                        ])})`,
                    },
                ]);
            }
        }
    };

    const add = (name: string, expression: string) => {
        const exported = schemaName(name);
        if (schemas.has(exported)) throw new Error(`Duplicate generated Effect schema ${literal(exported)}.`);
        schemas.set(
            exported,
            `export const ${exported}: __Schema.Codec<__Models.${name}, __Encoded.${name}> = __Schema.suspend(() => ${expression});`
        );
    };
    for (const type of ir.types) add(type.name, render(type.type));
    for (const object of ir.objectTypes)
        add(object.name, render({ kind: "struct", value: { fields: object.properties } }));
    for (const action of ir.actionTypes) {
        add(
            `${pascalCase(action.name)}Parameters`,
            struct(
                action.parameters.map((parameter) => {
                    const optional = parameter.type.kind === "optional";
                    const base = render(
                        parameter.type.kind === "optional" ? parameter.type.value.type : parameter.type
                    );
                    return {
                        name: parameter.name,
                        schema: optional
                            ? `__Schema.optional(__Schema.NullOr(${base}))`
                            : parameter.defaultValue !== undefined
                              ? `__Schema.optional(${base})`
                              : base,
                    };
                })
            )
        );
    }
    for (const query of ir.queryFunctionTypes) {
        add(
            `${pascalCase(query.name)}Parameters`,
            render({ kind: "struct", value: { fields: query.parameters } })
        );
        add(`${pascalCase(query.name)}Return`, render(query.returnType));
    }

    const registry = (name: string, entries: { name: string; type: string }[]) =>
        `export const ${name} = {${entries.map((entry) => `[${literal(entry.name)}]: ${schemaName(entry.type)}`).join(", ")}} as const;`;
    return [
        `import * as __Schema from "effect/Schema";`,
        `import * as __Values from ${literal(opts.valuesImportPath ?? "@party-stack/ontology-spec/effect")};`,
        `import type * as __Models from ${literal(opts.typesImportPath ?? "./effect-types.js")};`,
        `import type * as __Encoded from ${literal(opts.encodedTypesImportPath ?? "./types.js")};`,
        `export type * from ${literal(opts.typesImportPath ?? "./effect-types.js")};`,
        ...schemas.values(),
        registry(
            "namedSchemas",
            ir.types.map((type) => ({ name: type.name, type: type.name }))
        ),
        registry(
            "objectSchemas",
            ir.objectTypes.map((object) => ({ name: object.name, type: object.name }))
        ),
        registry(
            "actionParameterSchemas",
            ir.actionTypes.map((action) => ({
                name: action.name,
                type: `${pascalCase(action.name)}Parameters`,
            }))
        ),
        registry(
            "queryParameterSchemas",
            ir.queryFunctionTypes.map((query) => ({
                name: query.name,
                type: `${pascalCase(query.name)}Parameters`,
            }))
        ),
        registry(
            "queryReturnSchemas",
            ir.queryFunctionTypes.map((query) => ({
                name: query.name,
                type: `${pascalCase(query.name)}Return`,
            }))
        ),
    ].join("\n\n");
}
