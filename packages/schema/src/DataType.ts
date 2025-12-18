export interface NamedField {
    apiName: string;
    type: DataType;
    displayName: string;
    description?: string;
}

// TODO: interfaces
// TODO: object-based constraints (object set for allowed objects, object set + property id for allowed values, etc.)
// TODO: more constraints, can be type-specific based on how union is constructed

export type StringEnumConstraint = { type: "enum"; options: { label?: string; value: string }[] };
export type StringConstraints = StringEnumConstraint;

export type DataType = (
    | { type: "string"; constraints?: StringConstraints }
    | { type: "boolean" }
    | { type: "byte" }
    | { type: "short" }
    | { type: "integer" }
    | { type: "long" }
    | { type: "float" }
    | { type: "double" }
    | { type: "date" }
    | { type: "timestamp" }
    | { type: "geopoint" }
    | { type: "geoshape" }
    | { type: "attachment" }
    | { type: "array"; subtype: DataType }
    | {
          type: "struct";
          fields: NamedField[];
      }
    | { type: "objectReference"; objectTypeApiName: string }
    | { type: "objectSet"; objectTypeApiName: string }
    | { type: "unsupported"; typeName: string }
) & { required?: boolean };
