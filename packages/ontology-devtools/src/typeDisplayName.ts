import type { TypeDef } from "@party-stack/ontology";

export function typeDisplayName(type: TypeDef): string {
    switch (type.kind) {
        case "ref":
            return type.value.name;
        case "optional":
            return `${typeDisplayName(type.value.type)} (optional)`;
        case "list":
            return `List of ${typeDisplayName(type.value.elementType)}`;
        case "map":
            return `Map of ${typeDisplayName(type.value.valueType)}`;
        case "objectReference":
            return `${type.value.objectType} reference`;
        case "string":
            return "String";
        case "boolean":
            return "Boolean";
        case "integer":
            return "Integer";
        case "float":
            return "Float";
        case "double":
            return "Double";
        case "date":
            return "Date";
        case "timestamp":
            return "Timestamp";
        case "geopoint":
            return "Geopoint";
        case "struct":
            return "Struct";
        case "union":
            return "Union";
        case "result":
            return "Result";
        case "encrypted":
            return `Encrypted ${typeDisplayName(type.value.type)}`;
        case "attachment":
            return "Attachment";
        case "unknown":
            return "Unknown";
    }
}
