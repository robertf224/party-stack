// Auto-generated file - do not edit manually

import * as v from "@party-stack/ontology/values";

/** A renderer-independent icon name from @party-stack/icons. */
export type IconName =
    | "activity"
    | "add"
    | "airplane"
    | "alarm"
    | "alert"
    | "archive"
    | "arrow-down"
    | "arrow-left"
    | "arrow-right"
    | "arrow-up"
    | "attachment"
    | "award"
    | "bank"
    | "barcode"
    | "bell"
    | "book"
    | "bookmark"
    | "briefcase"
    | "bug"
    | "building"
    | "calculator"
    | "calendar"
    | "camera"
    | "chart-bar"
    | "chart-line"
    | "chart-pie"
    | "chat"
    | "check"
    | "check-circle"
    | "chevron-down"
    | "chevron-left"
    | "chevron-right"
    | "chevron-up"
    | "circle"
    | "clipboard"
    | "clock"
    | "cloud"
    | "code"
    | "compass"
    | "copy"
    | "credit-card"
    | "cube"
    | "database"
    | "delete"
    | "document"
    | "download"
    | "edit"
    | "email"
    | "error"
    | "eye"
    | "eye-off"
    | "filter"
    | "flag"
    | "folder"
    | "globe"
    | "grid"
    | "heart"
    | "help"
    | "history"
    | "home"
    | "image"
    | "info"
    | "key"
    | "layers"
    | "lightbulb"
    | "link"
    | "list"
    | "location"
    | "lock"
    | "lock-open"
    | "map"
    | "menu"
    | "microphone"
    | "minus"
    | "minus-circle"
    | "moon"
    | "more-horizontal"
    | "more-vertical"
    | "notification"
    | "package"
    | "pause"
    | "people"
    | "person"
    | "phone"
    | "pin"
    | "play"
    | "play-circle"
    | "plus-circle"
    | "printer"
    | "project"
    | "refresh"
    | "rocket"
    | "save"
    | "search"
    | "send"
    | "settings"
    | "share"
    | "shield"
    | "shopping-bag"
    | "shopping-cart"
    | "star"
    | "stop"
    | "sun"
    | "tag"
    | "ticket"
    | "tools"
    | "upload"
    | "video"
    | "warning"
    | "window"
    | "wrench"
    | "x"
    | "x-circle";

/** A portable icon descriptor with optional provider meta for lossless round trips. */
export type IconDescriptor = {
    /** Renderer-independent icon name. */
    name: IconName;
    /** Namespaced source-provider meta. */
    meta?: Record<string, unknown>;
};

export type Deprecation = {
    message: string;
};

/** A suggested value for a string. */
export type StringSuggestion = {
    value: string;
    label?: string;
};

/** Constrains a string to a set of allowed values. */
export type StringEnumConstraint = {
    options: Array<StringSuggestion>;
};

/** Constrains a string to a regex. */
export type StringRegexConstraint = {
    regex: string;
};

/** A constraint that can be applied to a string type. */
export type StringConstraint = v.Union<{
    enum: StringEnumConstraint;
    regex: StringRegexConstraint;
}>;

/** A string type with optional constraints. */
export type StringTypeDef = {
    constraint?: StringConstraint;
    suggestions?: Array<StringSuggestion>;
};

/** A boolean type. */
export type BooleanTypeDef = Record<never, never>;

/** A 32-bit integer type. */
export type IntegerTypeDef = Record<never, never>;

/** A 32-bit floating point type. */
export type FloatTypeDef = Record<never, never>;

/** A 64-bit floating point type. */
export type DoubleTypeDef = Record<never, never>;

/** A date type (no time component). */
export type DateTypeDef = Record<never, never>;

/** A timestamp type (instant in time). */
export type TimestampTypeDef = Record<never, never>;

/** A geographic point (lat/lon). */
export type GeopointTypeDef = Record<never, never>;

/** An opaque type whose shape is not known at schema time. */
export type UnknownTypeDef = Record<never, never>;

/** A list/array type. */
export type ListTypeDef = {
    /** The type of elements in the list. */
    elementType: TypeDef;
};

/** A map/record type. */
export type MapTypeDef = {
    /** The type of keys (must be string right now). */
    keyType: TypeDef;
    /** The type of values. */
    valueType: TypeDef;
};

/** Definition of a field in a struct. */
export type FieldDef = {
    /** The field name in code. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The field's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** A struct type with named fields. */
export type StructTypeDef = {
    fields: Array<FieldDef>;
};

/** Definition of a variant in a discriminated union. */
export type VariantDef = {
    /** The variant's discriminator value. */
    name: string;
    /** The variant's payload type. */
    type: TypeDef;
};

/** A discriminated union type. */
export type UnionTypeDef = {
    variants: Array<VariantDef>;
};

/** Wraps a type to make it optional. */
export type OptionalTypeDef = {
    /** The wrapped type. */
    type: TypeDef;
};

/** A result type (ok or error). */
export type ResultTypeDef = {
    /** The type of the success value. */
    okType: TypeDef;
    /** The type of the error value. */
    errType: TypeDef;
};

/** A reference to a named type. */
export type TypeRef = {
    /** The name of the referenced type. */
    name: string;
};

/** A type definition. Can be a primitive, collection, struct, union, optional, result, or reference. */
export type TypeDef = v.Union<{
    string: StringTypeDef;
    boolean: BooleanTypeDef;
    integer: IntegerTypeDef;
    float: FloatTypeDef;
    double: DoubleTypeDef;
    date: DateTypeDef;
    timestamp: TimestampTypeDef;
    geopoint: GeopointTypeDef;
    list: ListTypeDef;
    map: MapTypeDef;
    struct: StructTypeDef;
    union: UnionTypeDef;
    optional: OptionalTypeDef;
    result: ResultTypeDef;
    ref: TypeRef;
    attachment: AttachmentTypeDef;
    objectReference: ObjectReferenceTypeDef;
    unknown: UnknownTypeDef;
}>;

/** A supported image media type. */
export type ImageMediaType =
    | "image/bmp"
    | "image/tiff"
    | "image/nitf"
    | "image/jp2"
    | "image/jpeg"
    | "image/png"
    | "image/gif"
    | "image/svg+xml"
    | "image/webp";

/** Constrains intrinsic pixel dimensions. */
export type DimensionsConstraint = {
    width?: {
        min?: v.integer;
        max?: v.integer;
    };
    height?: {
        min?: v.integer;
        max?: v.integer;
    };
};

/** Constraints specific to image attachments. */
export type ImageAttachmentConstraint = {
    mediaTypes?: Array<ImageMediaType>;
    dimensions?: DimensionsConstraint;
};

/** Content-specific attachment constraints. */
export type AttachmentContentConstraint = v.Union<{
    image: ImageAttachmentConstraint;
}>;

/** Constraints applied to an attachment. */
export type AttachmentConstraint = {
    size?: {
        min?: v.double;
        max?: v.double;
    };
    content?: AttachmentContentConstraint;
};

/** A file handle with optional constraints. */
export type AttachmentTypeDef = {
    constraint?: AttachmentConstraint;
    meta?: Record<string, unknown>;
};

/** A reference to an ontology object type. */
export type ObjectReferenceTypeDef = {
    /** The referenced object type name. */
    objectType: string;
};

/** A property on an Object type. */
export type PropertyDef = {
    /** The provider-assigned stable identifier for this property. */
    id: string;
    /** The property's name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The property's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

export type LinkTypeSideDef = {
    objectType: string;
    name: string;
    displayName: string;
};

/** The cardinality of a link from the source's perspective. */
export type LinkCardinality = "one" | "many";

/** A parameter of an Action type. */
export type ActionParameterDef = {
    /** The parameter's name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The parameter's type. */
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
    /** The expression used when the caller does not provide a value. */
    defaultValue?: Expression;
};

/** Reads a named input from the root expression scope. */
export type InputReferenceExpression = {
    name: string;
};

/** Reads a named lexically scoped expression binding. */
export type LocalReferenceExpression = {
    name: string;
};

/** Reads a named value from the expression context. */
export type ContextReferenceExpression = {
    name: string;
};

/** Reads a structural path from a source expression. */
export type GetAtExpression = {
    source: Expression;
    path: Array<string>;
};

/** Resolves an object reference to its ontology object. */
export type ObjectLookupExpression = {
    reference: Expression;
};

/** Follows one named to-one ontology link from a source object. */
export type LinkHopExpression = {
    source: Expression;
    link: string;
};

/** A named field constructed by a struct expression. */
export type StructExpressionField = {
    name: string;
    value: Expression;
};

/** Constructs a struct value from field expressions. */
export type StructExpression = {
    fields: Array<StructExpressionField>;
};

/** Maps each element of a list to a new value. */
export type MapExpression = {
    source: Expression;
    binding: string;
    body: Expression;
};

/** Generates a UUID value. */
export type UuidExpression = Record<never, never>;

/** Returns the current timestamp. */
export type NowExpression = Record<never, never>;

/** A static literal value. */
export type LiteralExpression = {
    /** The literal value. */
    value: unknown;
};

/** An expression that resolves to a value. */
export type Expression = v.Union<{
    inputReference: InputReferenceExpression;
    contextReference: ContextReferenceExpression;
    localReference: LocalReferenceExpression;
    getAt: GetAtExpression;
    objectLookup: ObjectLookupExpression;
    linkHop: LinkHopExpression;
    struct: StructExpression;
    map: MapExpression;
    uuid: UuidExpression;
    now: NowExpression;
    literal: LiteralExpression;
}>;

/** Assigns an expression to a property path on an object written by an action. */
export type PropertyAssignment = {
    property: Array<string>;
    value: Expression;
};

/** Creates an object and assigns property values. */
export type CreateObjectActionLogicStep = {
    objectType: string;
    values: Array<PropertyAssignment>;
};

/** Updates a referenced object and assigns property values. */
export type UpdateObjectActionLogicStep = {
    object: InputReferenceExpression;
    values: Array<PropertyAssignment>;
};

/** Deletes a referenced object. */
export type DeleteObjectActionLogicStep = {
    object: InputReferenceExpression;
};

/** A logic step performed by an action. */
export type ActionLogicStep = v.Union<{
    createObject: CreateObjectActionLogicStep;
    updateObject: UpdateObjectActionLogicStep;
    deleteObject: DeleteObjectActionLogicStep;
}>;

/** A parameter accepted by a query function type. */
export type QueryFunctionParameterDef = {
    /** The query function parameter's programmatic name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    type: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** Moves a property from one path to another. */
export type MoveLensOp = {
    from: Array<string>;
    to: Array<string>;
};

/** Retains only the selected top-level properties. */
export type SelectLensOp = {
    properties: Array<string>;
};

/** One schema and value transformation operation. */
export type LensOp = v.Union<{
    move: MoveLensOp;
    select: SelectLensOp;
}>;

/** An ordered sequence of source-to-target transformation operations. */
export type Lens = {
    operations: Array<LensOp>;
};

/** A named type definition that can be referenced by other types. */
export type ValueType = {
    /** The type's name for use in code. */
    name: string;
    /** Optional documentation for the type. */
    description?: string;
    deprecated?: Deprecation;
    /** The type definition. */
    type: TypeDef;
};

/** An object type in the ontology. */
export type ObjectType = {
    /** The provider-assigned stable identifier for this object type. */
    id: string;
    /** The object type's programmatic name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    pluralDisplayName: string;
    /** The name of the property that serves as primary key. */
    primaryKey: string;
    /** The optional property name used as the human-readable title for an object. */
    title?: string;
    /** Optional portable icon descriptor. */
    icon?: IconDescriptor;
    /** Optional display color independent of the icon. */
    color?: string;
    /** The object type's propertieo. */
    properties: Array<PropertyDef>;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** A relationship between two object types. */
export type LinkType = {
    id: string;
    source: LinkTypeSideDef;
    target: LinkTypeSideDef;
    /** The foreign key on the source. */
    foreignKey: string;
    /** How many sources are linked to the target. */
    cardinality: "one" | "many";
};

/** An action type in the ontology. */
export type ActionType = {
    /** The provider-assigned stable identifier for this action type. */
    id: string;
    /** Provider-specific metadata used to execute this action. */
    meta?: Record<string, unknown>;
    /** The object type's programmatic name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** Optional portable icon descriptor. */
    icon?: IconDescriptor;
    /** Optional display color independent of the icon. */
    color?: string;
    /** The action type's parametero. */
    parameters: Array<ActionParameterDef>;
    /** The action type's local logic stepo. */
    logic: Array<ActionLogicStep>;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

/** A runnable query function type in the ontology. */
export type QueryFunctionType = {
    /** The query function type's programmatic name. */
    name: string;
    /** Human-readable name. */
    displayName: string;
    /** The query function type's parameters. */
    parameters: Array<QueryFunctionParameterDef>;
    /** The query function type's return type. */
    returnType: TypeDef;
    /** Optional description. */
    description?: string;
    deprecated?: Deprecation;
};

export type MetaOntologyContext = Record<string, unknown>;
export type MetaOntology = {
    context: MetaOntologyContext;
    objectTypes: {
        ValueType: ValueType;
        ObjectType: ObjectType;
        LinkType: LinkType;
        ActionType: ActionType;
        QueryFunctionType: QueryFunctionType;
    };
    actionTypes: Record<never, never>;
    queryFunctionTypes: Record<never, never>;
};
