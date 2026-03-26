import { Temporal } from "temporal-polyfill";
import { CodeBlockWriter, Project, type WriterFunction } from "ts-morph";
import type {
    ActionTypeDef,
    Deprecation,
    Expression,
    FieldDef,
    LinkTypeDef,
    LinkTypeSideDef,
    NamedTypeDef,
    ObjectTypeDef,
    PropertyAssignment,
    PropertyDef,
    StringConstraint,
    TypeDef,
    VariantDef,
    OntologyIR,
} from "../ir/generated/types.js";

export interface GenerateOntologyOpts {
    ontologyImportPath?: string;
}

function withWriter(fn: WriterFunction): string {
    const writer = new CodeBlockWriter();
    fn(writer);
    return writer.toString();
}

function isIdentifier(value: string): boolean {
    return /^[$A-Z_a-z][$\w]*$/.test(value);
}

function writePropertyName(writer: CodeBlockWriter, name: string): void {
    writer.write(isIdentifier(name) ? name : JSON.stringify(name));
}

function writeArray(writer: CodeBlockWriter, values: string[]): void {
    if (values.length === 0) {
        writer.write("[]");
        return;
    }

    writer.write("[");
    writer.newLine();
    writer.indent(() => {
        for (const value of values) {
            writer.write(value);
            writer.write(",");
            writer.newLine();
        }
    });
    writer.write("]");
}

function writeObject(
    writer: CodeBlockWriter,
    entries: Array<{ name: string; value: string | undefined }>
): void {
    const definedEntries = entries.filter((entry) => entry.value !== undefined);
    if (definedEntries.length === 0) {
        writer.write("{}");
        return;
    }

    writer.write("{");
    writer.newLine();
    writer.indent(() => {
        for (const entry of definedEntries) {
            writePropertyName(writer, entry.name);
            writer.write(": ");
            writer.write(entry.value!);
            writer.write(",");
            writer.newLine();
        }
    });
    writer.write("}");
}

function renderObject(entries: Array<{ name: string; value: string | undefined }>): string {
    return withWriter((writer) => writeObject(writer, entries));
}

interface RenderContext {
    markTemporalUsed(): void;
}

function renderPlainValue(value: unknown, ctx?: RenderContext): string {
    return withWriter((writer) => writePlainValue(writer, value, ctx));
}

function writePlainValue(writer: CodeBlockWriter, value: unknown, ctx?: RenderContext): void {
    if (value === null) {
        writer.write("null");
        return;
    }

    if (value === undefined) {
        writer.write("undefined");
        return;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        writer.write(JSON.stringify(value));
        return;
    }

    if (value instanceof Temporal.Instant) {
        ctx?.markTemporalUsed();
        writer.write(`Temporal.Instant.from(${JSON.stringify(value.toString())})`);
        return;
    }

    if (value instanceof Temporal.PlainDate) {
        ctx?.markTemporalUsed();
        writer.write(`Temporal.PlainDate.from(${JSON.stringify(value.toString())})`);
        return;
    }

    if (Array.isArray(value)) {
        writeArray(
            writer,
            value.map((entry) => renderPlainValue(entry, ctx))
        );
        return;
    }

    writeObject(
        writer,
        Object.entries(value).map(([name, entryValue]) => ({
            name,
            value: entryValue === undefined ? undefined : renderPlainValue(entryValue, ctx),
        }))
    );
}

function renderDeprecation(value: Deprecation | undefined): string | undefined {
    return value === undefined ? undefined : renderPlainValue(value);
}

function renderStringConstraint(constraint: StringConstraint): string {
    switch (constraint.kind) {
        case "enum":
            return `o.StringConstraint.enum(${renderPlainValue(constraint.value)})`;
        case "regex":
            return `o.StringConstraint.regex(${renderPlainValue(constraint.value)})`;
    }
}

function renderType(type: TypeDef): string {
    switch (type.kind) {
        case "string":
            return `o.string(${renderObject([
                {
                    name: "constraint",
                    value: type.value.constraint ? renderStringConstraint(type.value.constraint) : undefined,
                },
            ])})`;
        case "boolean":
            return `o.boolean(${renderPlainValue(type.value)})`;
        case "integer":
            return `o.integer(${renderPlainValue(type.value)})`;
        case "float":
            return `o.float(${renderPlainValue(type.value)})`;
        case "double":
            return `o.double(${renderPlainValue(type.value)})`;
        case "date":
            return `o.date(${renderPlainValue(type.value)})`;
        case "timestamp":
            return `o.timestamp(${renderPlainValue(type.value)})`;
        case "geopoint":
            return `o.geopoint(${renderPlainValue(type.value)})`;
        case "attachment":
            return `o.attachment(${renderPlainValue(type.value)})`;
        case "objectReference":
            return `o.objectReference(${renderPlainValue(type.value)})`;
        case "unknown":
            return `o.unknown(${renderPlainValue(type.value)})`;
        case "list":
            return `o.list(${renderObject([{ name: "elementType", value: renderType(type.value.elementType) }])})`;
        case "map":
            return `o.map(${renderObject([
                { name: "keyType", value: renderType(type.value.keyType) },
                { name: "valueType", value: renderType(type.value.valueType) },
            ])})`;
        case "struct":
            return `o.struct(${renderObject([
                {
                    name: "fields",
                    value: withWriter((writer) =>
                        writeArray(
                            writer,
                            type.value.fields.map((field) => renderField(field))
                        )
                    ),
                },
            ])})`;
        case "union":
            return `o.union(${renderObject([
                {
                    name: "variants",
                    value: withWriter((writer) =>
                        writeArray(
                            writer,
                            type.value.variants.map((variant) => renderVariant(variant))
                        )
                    ),
                },
            ])})`;
        case "optional":
            return `o.optional(${renderObject([{ name: "type", value: renderType(type.value.type) }])})`;
        case "result":
            return `o.result(${renderObject([
                { name: "okType", value: renderType(type.value.okType) },
                { name: "errType", value: renderType(type.value.errType) },
            ])})`;
        case "ref":
            return `o.ref(${renderPlainValue(type.value)})`;
    }
}

function renderField(field: FieldDef): string {
    return renderObject([
        { name: "name", value: renderPlainValue(field.name) },
        { name: "displayName", value: renderPlainValue(field.displayName) },
        { name: "type", value: renderType(field.type) },
        { name: "description", value: field.description ? renderPlainValue(field.description) : undefined },
        { name: "deprecated", value: renderDeprecation(field.deprecated) },
    ]);
}

function renderVariant(variant: VariantDef): string {
    return renderObject([
        { name: "name", value: renderPlainValue(variant.name) },
        { name: "type", value: renderType(variant.type) },
    ]);
}

function renderNamedType(type: NamedTypeDef): string {
    return renderObject([
        { name: "name", value: renderPlainValue(type.name) },
        { name: "description", value: type.description ? renderPlainValue(type.description) : undefined },
        { name: "deprecated", value: renderDeprecation(type.deprecated) },
        { name: "type", value: renderType(type.type) },
    ]);
}

function renderProperty(property: PropertyDef): string {
    return renderObject([
        { name: "name", value: renderPlainValue(property.name) },
        { name: "displayName", value: renderPlainValue(property.displayName) },
        { name: "type", value: renderType(property.type) },
        {
            name: "description",
            value: property.description ? renderPlainValue(property.description) : undefined,
        },
        { name: "deprecated", value: renderDeprecation(property.deprecated) },
    ]);
}

function renderObjectType(objectType: ObjectTypeDef): string {
    return renderObject([
        { name: "name", value: renderPlainValue(objectType.name) },
        { name: "displayName", value: renderPlainValue(objectType.displayName) },
        { name: "pluralDisplayName", value: renderPlainValue(objectType.pluralDisplayName) },
        { name: "primaryKey", value: renderPlainValue(objectType.primaryKey) },
        {
            name: "properties",
            value: withWriter((writer) =>
                writeArray(
                    writer,
                    objectType.properties.map((property) => renderProperty(property))
                )
            ),
        },
        {
            name: "description",
            value: objectType.description ? renderPlainValue(objectType.description) : undefined,
        },
        { name: "deprecated", value: renderDeprecation(objectType.deprecated) },
    ]);
}

function renderLinkTypeSide(side: LinkTypeSideDef): string {
    return renderObject([
        { name: "objectType", value: renderPlainValue(side.objectType) },
        { name: "name", value: renderPlainValue(side.name) },
        { name: "displayName", value: renderPlainValue(side.displayName) },
    ]);
}

function renderLinkType(linkType: LinkTypeDef): string {
    return renderObject([
        { name: "id", value: renderPlainValue(linkType.id) },
        { name: "source", value: renderLinkTypeSide(linkType.source) },
        { name: "target", value: renderLinkTypeSide(linkType.target) },
        { name: "foreignKey", value: renderPlainValue(linkType.foreignKey) },
        { name: "cardinality", value: renderPlainValue(linkType.cardinality) },
    ]);
}

function renderExpression(expression: Expression, ctx?: RenderContext): string {
    return `o.Expression.${expression.kind}(${renderPlainValue(expression.value, ctx)})`;
}

function renderActionPropertyAssignment(assignment: PropertyAssignment, ctx?: RenderContext): string {
    return renderObject([
        { name: "property", value: renderPlainValue(assignment.property) },
        { name: "value", value: renderExpression(assignment.value, ctx) },
    ]);
}

function renderActionType(actionType: ActionTypeDef, ctx?: RenderContext): string {
    return renderObject([
        { name: "name", value: renderPlainValue(actionType.name) },
        { name: "displayName", value: renderPlainValue(actionType.displayName) },
        {
            name: "parameters",
            value: withWriter((writer) =>
                writeArray(
                    writer,
                    actionType.parameters.map((parameter) =>
                        renderObject([
                            { name: "name", value: renderPlainValue(parameter.name) },
                            { name: "displayName", value: renderPlainValue(parameter.displayName) },
                            { name: "type", value: renderType(parameter.type) },
                            {
                                name: "description",
                                value: parameter.description ? renderPlainValue(parameter.description) : undefined,
                            },
                            { name: "deprecated", value: renderDeprecation(parameter.deprecated) },
                            {
                                name: "defaultValue",
                                value: parameter.defaultValue
                                    ? renderExpression(parameter.defaultValue, ctx)
                                    : undefined,
                            },
                        ])
                    )
                )
            ),
        },
        {
            name: "logic",
            value: withWriter((writer) =>
                writeArray(
                    writer,
                    actionType.logic.map((step) =>
                        `o.ActionLogicStep.${step.kind}(${renderObject([
                            {
                                name: "objectType",
                                value:
                                    "objectType" in step.value
                                        ? renderPlainValue(step.value.objectType)
                                        : undefined,
                            },
                            {
                                name: "object",
                                value:
                                    "object" in step.value
                                        ? renderPlainValue(step.value.object)
                                        : undefined,
                            },
                            {
                                name: "values",
                                value:
                                    "values" in step.value
                                        ? withWriter((arrayWriter) =>
                                              writeArray(
                                                  arrayWriter,
                                                  ("values" in step.value ? step.value.values : []).map((value) =>
                                                      renderActionPropertyAssignment(value, ctx)
                                                  )
                                              )
                                          )
                                        : undefined,
                            },
                        ])})`
                    )
                )
            ),
        },
        { name: "description", value: actionType.description ? renderPlainValue(actionType.description) : undefined },
        { name: "deprecated", value: renderDeprecation(actionType.deprecated) },
    ]);
}

export function generateOntology(ir: OntologyIR, opts: GenerateOntologyOpts = {}): string {
    const ontologyImportPath = opts.ontologyImportPath ?? "@party-stack/ontology";
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("ontology.ts", "");

    let usesTemporalTypes = false;
    const ctx: RenderContext = {
        markTemporalUsed() {
            usesTemporalTypes = true;
        },
    };

    const renderedActionTypes = ir.actionTypes.map((actionType) => renderActionType(actionType, ctx));

    sourceFile.addImportDeclaration({
        moduleSpecifier: ontologyImportPath,
        namedImports: ["o"],
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: ontologyImportPath,
        namedImports: ["OntologyIR"],
        isTypeOnly: true,
    });
    if (usesTemporalTypes) {
        sourceFile.addImportDeclaration({
            moduleSpecifier: "temporal-polyfill",
            namedImports: ["Temporal"],
        });
    }

    sourceFile.addStatements((writer) => {
        writer.write("export default ");
        writeObject(writer, [
            {
                name: "types",
                value: withWriter((arrayWriter) =>
                    writeArray(
                        arrayWriter,
                        ir.types.map((type) => renderNamedType(type))
                    )
                ),
            },
            {
                name: "objectTypes",
                value: withWriter((arrayWriter) =>
                    writeArray(
                        arrayWriter,
                        ir.objectTypes.map((objectType) => renderObjectType(objectType))
                    )
                ),
            },
            {
                name: "linkTypes",
                value: withWriter((arrayWriter) =>
                    writeArray(
                        arrayWriter,
                        ir.linkTypes.map((linkType) => renderLinkType(linkType))
                    )
                ),
            },
            {
                name: "actionTypes",
                value: withWriter((arrayWriter) =>
                    writeArray(arrayWriter, renderedActionTypes)
                ),
            },
        ]);
        writer.write(" satisfies OntologyIR;");
        writer.newLine();
    });

    return sourceFile.getFullText().trim();
}
