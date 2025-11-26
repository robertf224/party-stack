import { ObjectTypeFullMetadata, ObjectPropertyType } from "@osdk/foundry.ontologies";

function getZodSchemaCodeForPropertyType(propertyType: ObjectPropertyType): string {
    switch (propertyType.type) {
        case "string":
            return "z.string()";
        case "integer":
            return "z.number().int()";
        case "long":
            return "z.number().int()";
        case "short":
            return "z.number().int()";
        case "byte":
            return "z.number().int().min(0).max(255)";
        case "boolean":
            return "z.boolean()";
        case "double":
            return "z.number()";
        case "float":
            return "z.number()";
        case "decimal":
            return "z.number()";
        case "date":
            return "z.string()"; // ISO date string
        case "timestamp":
            return "z.string()"; // ISO timestamp string
        case "array":
            return `z.array(${getZodSchemaCodeForPropertyType(propertyType.subType)})`;
        case "attachment":
            return "z.unknown()"; // Unsupported complex type
        case "cipherText":
            return "z.string()";
        case "geopoint":
            return "z.unknown()"; // Unsupported complex type
        case "geoshape":
            return "z.unknown()"; // Unsupported complex type
        case "geotimeSeriesReference":
            return "z.unknown()"; // Unsupported complex type
        case "marking":
            return "z.unknown()"; // Unsupported complex type
        case "mediaReference":
            return "z.unknown()"; // Unsupported complex type
        case "struct":
            return "z.unknown()"; // Unsupported complex type
        case "timeseries":
            return "z.unknown()"; // Unsupported complex type
        case "vector":
            return "z.unknown()"; // Unsupported complex type
        default:
            return "z.unknown()";
    }
}

export function generateObjectTypeSchemaFileContent(objectType: ObjectTypeFullMetadata): string {
    const apiName = objectType.objectType.apiName;
    const primaryKey = objectType.objectType.primaryKey;
    const properties = objectType.objectType.properties;

    const schemaFields: string[] = [];

    // Process all properties
    for (const [propertyApiName, property] of Object.entries(properties)) {
        const zodSchemaCode = getZodSchemaCodeForPropertyType(property.dataType);

        // Primary key is required, all others are optional
        const fieldCode =
            propertyApiName === primaryKey
                ? `${propertyApiName}: ${zodSchemaCode}`
                : `${propertyApiName}: ${zodSchemaCode}.optional()`;

        schemaFields.push(fieldCode);
    }

    // Generate the file content
    const imports = `import { z } from "zod";`;
    const schemaDefinition = `export const ${apiName} = z.object({\n${schemaFields.map((field) => `    ${field}`).join(",\n")}\n});`;

    return `${imports}\n\n${schemaDefinition}\n`;
}
