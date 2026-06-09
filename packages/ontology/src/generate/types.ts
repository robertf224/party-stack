import { pascalCase } from "change-case";
import { CodeBlockWriter, Project, Writers, type WriterFunction } from "ts-morph";
import { buildJsDocs } from "./utils/buildJsDocs.js";
import type {
    OntologyIR,
    ObjectTypeDef,
    StructTypeDef,
    TypeDef,
    UnionTypeDef,
} from "../ir/generated/types.js";

function withWriter(fn: WriterFunction): string {
    const writer = new CodeBlockWriter();
    fn(writer);
    return writer.toString();
}

function union(options: string[]): string {
    if (options.length === 0) {
        return "never";
    }
    if (options.length === 1) {
        return options[0]!;
    }
    return withWriter(Writers.unionType(options[0]!, options[1]!, ...options.slice(2)));
}

function renderPropertyName(name: string): string {
    return /^[$A-Z_][0-9A-Z_$]*$/i.test(name) ? name : JSON.stringify(name);
}

export interface GenerateTypeDefinitionsOpts {
    valuesImportPath?: string;
    objectTypes?: ReadonlyMap<string, ObjectTypeDef>;
}

interface GenerateTypeContext {
    objectTypes?: ReadonlyMap<string, ObjectTypeDef>;
}

export function generateForTypeDef(type: TypeDef, ctx: GenerateTypeContext = {}): string {
    switch (type.kind) {
        case "string": {
            if (type.value.constraint?.kind === "enum") {
                const options = type.value.constraint.value.options;
                return union(options.map((option) => `"${option.value}"`));
            }
            return "string";
        }

        case "boolean":
            return "boolean";

        case "integer":
            return "v.integer";

        case "float":
            return "v.float";

        case "double":
            return "v.double";

        case "date":
            return "v.date";

        case "timestamp":
            return "v.timestamp";

        case "geopoint":
            return "v.geopoint";

        case "attachment":
            return "v.attachment";

        case "objectReference": {
            const objectType = ctx.objectTypes?.get(type.value.objectType);
            if (!objectType) {
                throw new Error(
                    `Cannot generate object reference type for unknown object type "${type.value.objectType}".`
                );
            }
            const primaryKey = objectType?.properties.find(
                (property) => property.name === objectType.primaryKey
            );
            if (!primaryKey) {
                throw new Error(
                    `Cannot generate object reference type for "${type.value.objectType}" because primary key "${objectType.primaryKey}" is not a property.`
                );
            }
            return generateForTypeDef(primaryKey.type, ctx);
        }

        case "unknown":
            return "unknown";

        case "list":
            return `Array<${generateForTypeDef(type.value.elementType, ctx)}>`;

        case "map":
            return `Record<string, ${generateForTypeDef(type.value.valueType, ctx)}>`;

        case "struct":
            return generateForStructTypeDef(type.value, ctx);

        case "union":
            return generateForUnionTypeDef(type.value, ctx);

        case "optional":
            return union([generateForTypeDef(type.value.type, ctx), "undefined"]);

        case "result":
            return `v.Result<${generateForTypeDef(type.value.okType, ctx)}, ${generateForTypeDef(type.value.errType, ctx)}>`;

        case "ref":
            return type.value.name;
    }
}

function generateForStructTypeDef(type: StructTypeDef, ctx: GenerateTypeContext): string {
    if (type.fields.length === 0) {
        return "Record<never, never>";
    }

    return withWriter(
        Writers.objectType({
            properties: type.fields.map((field) => {
                const { fieldType, isOptional } =
                    field.type.kind === "optional"
                        ? { fieldType: field.type.value.type, isOptional: true }
                        : { fieldType: field.type, isOptional: false };
                return {
                    name: renderPropertyName(field.name),
                    type: generateForTypeDef(fieldType, ctx),
                    hasQuestionToken: isOptional,
                    docs: buildJsDocs({ description: field.description, deprecated: field.deprecated }),
                };
            }),
        })
    );
}

function generateForUnionTypeDef(type: UnionTypeDef, ctx: GenerateTypeContext): string {
    const innerType = withWriter(
        Writers.objectType({
            properties: type.variants.map((variant) => ({
                name: renderPropertyName(variant.name),
                type: generateForTypeDef(variant.type, ctx),
            })),
        })
    );
    return `v.Union<${innerType}>`;
}

function collectTypeDefinitions(ir: OntologyIR): Pick<OntologyIR, "types"> {
    return {
        types: [
            ...ir.types,
            ...ir.objectTypes.map((objectType) => ({
                name: objectType.name,
                description: objectType.description,
                deprecated: objectType.deprecated,
                type: {
                    kind: "struct" as const,
                    value: {
                        fields: objectType.properties,
                    },
                },
            })),
        ],
    };
}

export function generateTypeDefinitions(
    schema: Pick<OntologyIR, "types">,
    opts: GenerateTypeDefinitionsOpts = {}
): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("types.ts", "");

    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.valuesImportPath ?? "@party-stack/ontology/values",
        namespaceImport: "v",
    });

    for (const type of schema.types) {
        sourceFile.addTypeAlias({
            name: type.name,
            isExported: true,
            type: generateForTypeDef(type.type, { objectTypes: opts.objectTypes }),
            docs: buildJsDocs({ description: type.description, deprecated: type.deprecated }),
        });
    }

    const typeAliases = sourceFile.getTypeAliases();
    for (const alias of typeAliases.slice(0, -1)) {
        alias.appendWhitespace("\n");
    }

    return sourceFile.getFullText().trim();
}

export interface GenerateTypesOpts {
    outputTypeName?: string;
}

function addOntologyAggregateType(
    sourceFile: import("ts-morph").SourceFile,
    ir: OntologyIR,
    outputTypeName: string
): void {
    const properties = [
        {
            name: "objectTypes",
            type:
                ir.objectTypes.length === 0
                    ? "Record<never, never>"
                    : Writers.objectType({
                          properties: ir.objectTypes.map((objectType) => ({
                              name: renderPropertyName(objectType.name),
                              type: objectType.name,
                          })),
                      }),
        },
    ];

    properties.push({
        name: "actionTypes",
        type:
            ir.actionTypes.length === 0
                ? "Record<never, never>"
                : Writers.objectType({
                      properties: ir.actionTypes.map((action) => ({
                          name: renderPropertyName(action.name),
                          type: Writers.objectType({
                              properties: [
                                  {
                                      name: "parameters",
                                      type: `${pascalCase(action.name)}Parameters`,
                                  },
                              ],
                          }),
                      })),
                  }),
    });

    sourceFile.addTypeAlias({
        name: outputTypeName,
        isExported: true,
        type: Writers.objectType({ properties }),
    });
}

function addActionParameterTypes(sourceFile: import("ts-morph").SourceFile, ir: OntologyIR): void {
    const objectTypes = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    for (const actionType of ir.actionTypes) {
        sourceFile.addTypeAlias({
            name: `${pascalCase(actionType.name)}Parameters`,
            isExported: true,
            type: withWriter(
                Writers.objectType({
                    properties: actionType.parameters.map((parameter) => {
                        const parameterType = parameter.type;
                        const isOptional = parameterType.kind === "optional";
                        const type = isOptional ? parameterType.value.type : parameterType;
                        const renderedType = generateForTypeDef(type, { objectTypes });
                        return {
                            name: renderPropertyName(parameter.name),
                            type: isOptional ? union([renderedType, "null"]) : renderedType,
                            hasQuestionToken: isOptional || parameter.defaultValue !== undefined,
                        };
                    }),
                })
            ),
        });
    }
}

export function generateTypes(ir: OntologyIR, opts: GenerateTypesOpts = {}): string {
    const outputTypeName = opts.outputTypeName ?? "GeneratedOntology";
    const objectTypes = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    const typeDefinitions = generateTypeDefinitions(collectTypeDefinitions(ir), {
        objectTypes,
    });
    const project = new Project({ useInMemoryFileSystem: true });
    const aggregateFile = project.createSourceFile("ontology-aggregate.ts", "");
    addActionParameterTypes(aggregateFile, ir);
    addOntologyAggregateType(aggregateFile, ir, outputTypeName);
    return `${typeDefinitions}\n\n${aggregateFile.getFullText().trim()}`.trim();
}
