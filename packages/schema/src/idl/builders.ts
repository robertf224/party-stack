/**
 * TypeScript-based IDL for defining schemas.
 *
 * This provides a fluent builder API that produces Schema IR.
 * Types are optional by default. Use .required() to make them required.
 */

import type {
    FieldDef,
    ListTypeDef,
    MapTypeDef,
    NamedTypeDef,
    SchemaIR,
    StringConstraint,
    StructTypeDef,
    TypeDef,
    TypeRef,
    UnionTypeDef,
    VariantDef,
} from "../ir/ir.js";

// ============================================================================
// Type Expression Wrappers (for inference and chaining)
// ============================================================================

/**
 * A type expression wrapper that enables chaining methods.
 */
export interface TypeExprBuilder<T extends TypeDef = TypeDef> {
    readonly _expr: T;
    readonly _name?: string;
    readonly _description?: string;

    /** Mark this type as required (types are optional by default) */
    required(): TypeExprBuilder<T>;
}

/**
 * Create a basic type expression builder.
 */
function createTypeExprBuilder<T extends TypeDef>(
    expr: T,
    name?: string,
    description?: string
): TypeExprBuilder<T> {
    return {
        _expr: expr,
        _name: name,
        _description: description,
        required(): TypeExprBuilder<T> {
            return createTypeExprBuilder({ ...expr, required: true }, name, description);
        },
    };
}

/**
 * Build a NamedTypeDef from any TypeExprBuilder.
 */
function buildNamedDef(name: string, builder: TypeExprBuilder, description?: string): NamedTypeDef {
    return {
        apiName: name,
        description: description ?? builder._description,
        type: builder._expr,
    };
}

// ============================================================================
// Struct Builder
// ============================================================================

type FieldsDefinition = Record<string, TypeExprBuilder>;

export class StructBuilder implements TypeExprBuilder<StructTypeDef> {
    private readonly _fields: FieldsDefinition;
    readonly _description?: string;
    readonly _name?: string;

    constructor(fields: FieldsDefinition, description?: string, name?: string) {
        this._fields = fields;
        this._description = description;
        this._name = name;
    }

    get _expr(): StructTypeDef {
        return {
            kind: "struct",
            fields: this._buildFields(),
        };
    }

    required(): TypeExprBuilder<StructTypeDef> {
        return createTypeExprBuilder({ ...this._expr, required: true }, this._name, this._description);
    }

    /** Build field definitions */
    private _buildFields(): FieldDef[] {
        const fields: FieldDef[] = [];
        for (const [name, builder] of Object.entries(this._fields)) {
            // If the builder has a name, use a ref instead of inlining
            const type =
                builder._name != null
                    ? { kind: "ref" as const, apiName: builder._name, required: builder._expr.required }
                    : builder._expr;

            fields.push({
                apiName: name,
                displayName: name,
                type,
            });
        }
        return fields;
    }

    /** Create a copy with a name assigned */
    _withName(name: string): StructBuilder {
        return new StructBuilder(this._fields, this._description, name);
    }
}

// ============================================================================
// Union Builder
// ============================================================================

type VariantsDefinition = Record<string, TypeExprBuilder>;

export class UnionBuilder implements TypeExprBuilder<UnionTypeDef> {
    private readonly _tagField: string;
    private readonly _variants: VariantsDefinition;
    readonly _description?: string;
    readonly _name?: string;

    constructor(tagField: string, variants: VariantsDefinition, description?: string, name?: string) {
        this._tagField = tagField;
        this._variants = variants;
        this._description = description;
        this._name = name;
    }

    get _expr(): UnionTypeDef {
        return {
            kind: "union",
            variants: this._buildVariants(),
        };
    }

    required(): TypeExprBuilder<UnionTypeDef> {
        return createTypeExprBuilder({ ...this._expr, required: true }, this._name, this._description);
    }

    private _buildVariants(): VariantDef[] {
        const variants: VariantDef[] = [];
        for (const [name, builder] of Object.entries(this._variants)) {
            // If the builder has a name, use a ref instead of inlining
            const type =
                builder._name != null
                    ? { kind: "ref" as const, apiName: builder._name, required: builder._expr.required }
                    : builder._expr;

            variants.push({
                apiName: name,
                type,
            });
        }
        return variants;
    }

    /** Create a copy with a name assigned */
    _withName(name: string): UnionBuilder {
        return new UnionBuilder(this._tagField, this._variants, this._description, name);
    }
}

// ============================================================================
// Schema Builder
// ============================================================================

export class SchemaBuilder {
    private readonly _types: Map<string, TypeExprBuilder> = new Map();

    /**
     * Register a named type with this schema.
     * Any type expression can be named - primitives, lists, structs, etc.
     *
     * @param name The name for this type
     * @param builder The type builder
     */
    add(name: string, builder: TypeExprBuilder): this {
        // Create a version with the name assigned
        if (builder instanceof StructBuilder) {
            this._types.set(name, builder._withName(name));
        } else if (builder instanceof UnionBuilder) {
            this._types.set(name, builder._withName(name));
        } else {
            // For other types, create a new builder with the name
            this._types.set(name, createTypeExprBuilder(builder._expr, name, builder._description));
        }
        return this;
    }

    /**
     * Build the complete schema IR.
     */
    build(): SchemaIR {
        const types: NamedTypeDef[] = [];
        for (const [name, builder] of this._types) {
            types.push(buildNamedDef(name, builder));
        }
        return { types };
    }
}

// ============================================================================
// String Enum Builder
// ============================================================================

export interface StringEnumBuilder extends TypeExprBuilder<TypeDef> {
    readonly _expr: TypeDef & { kind: "string"; constraint: StringConstraint };
}

function createStringEnumBuilder(
    options: readonly (string | { value: string; label?: string })[],
    description?: string
): StringEnumBuilder {
    const enumOptions = options.map((opt) => (typeof opt === "string" ? { value: opt } : opt));
    const expr: TypeDef = {
        kind: "string",
        constraint: { kind: "enum", options: enumOptions },
    };
    return createTypeExprBuilder(expr, undefined, description) as StringEnumBuilder;
}

// ============================================================================
// Main Schema DSL (the "s" object)
// ============================================================================

/**
 * The main schema DSL entry point.
 *
 * Usage:
 * ```ts
 * import { s } from "@party-stack/schema";
 *
 * // Any type can be named - primitives, lists, structs, etc.
 * const UserId = s.string();
 * const Tags = s.list(s.string());
 * const Address = s.struct({
 *   line1: s.string().required(),
 *   city: s.string().required(),
 * });
 *
 * const Order = s.struct({
 *   id: s.string().required(),
 *   shipTo: s.ref("Address"),  // reference by name
 * });
 *
 * // Register types in schema
 * const schema = s.schema()
 *   .add("UserId", UserId)      // Named string type
 *   .add("Tags", Tags)          // Named list type
 *   .add("Address", Address)    // Named struct type
 *   .add("Order", Order)
 *   .build();
 * ```
 */
export const s = {
    // Primitives (all optional by default)
    string: (description?: string) =>
        createTypeExprBuilder<TypeDef>({ kind: "string" }, undefined, description),
    boolean: (description?: string) =>
        createTypeExprBuilder<TypeDef>({ kind: "boolean" }, undefined, description),
    integer: (description?: string) =>
        createTypeExprBuilder<TypeDef>({ kind: "integer" }, undefined, description),
    long: (description?: string) => createTypeExprBuilder<TypeDef>({ kind: "long" }, undefined, description),
    float: (description?: string) =>
        createTypeExprBuilder<TypeDef>({ kind: "float" }, undefined, description),
    double: (description?: string) =>
        createTypeExprBuilder<TypeDef>({ kind: "double" }, undefined, description),
    date: (description?: string) => createTypeExprBuilder<TypeDef>({ kind: "date" }, undefined, description),
    timestamp: (description?: string) =>
        createTypeExprBuilder<TypeDef>({ kind: "timestamp" }, undefined, description),

    /**
     * Create a string with enum constraint.
     * @param options Array of allowed values with optional labels
     */
    stringEnum: (
        options: readonly (string | { value: string; label?: string })[],
        description?: string
    ): StringEnumBuilder => {
        return createStringEnumBuilder(options, description);
    },

    // Composites
    list: (element: TypeExprBuilder, description?: string): TypeExprBuilder<ListTypeDef> => {
        // If the element has a name, use a ref
        const elementType =
            element._name != null
                ? { kind: "ref" as const, apiName: element._name, required: element._expr.required }
                : element._expr;
        return createTypeExprBuilder({ kind: "list", elementType }, undefined, description);
    },

    map: (value: TypeExprBuilder, description?: string): TypeExprBuilder<MapTypeDef> =>
        createTypeExprBuilder(
            { kind: "map", keyType: { kind: "string" }, valueType: value._expr },
            undefined,
            description
        ),

    /**
     * Create a struct type.
     */
    struct: (fields: FieldsDefinition, description?: string): StructBuilder =>
        new StructBuilder(fields, description),

    /**
     * Create a union type.
     */
    union: (tagField: string, variants: VariantsDefinition, description?: string): UnionBuilder =>
        new UnionBuilder(tagField, variants, description),

    /**
     * Create a reference to a named type by string name.
     * @param name The name of the type to reference
     */
    ref: (name: string): TypeExprBuilder<TypeRef> => createTypeExprBuilder({ kind: "ref", apiName: name }),

    /**
     * Create a new schema builder.
     */
    schema: (): SchemaBuilder => new SchemaBuilder(),
};
