import { decode, encode } from "@party-stack/ontology/json";
import { resolveType } from "@party-stack/ontology/utils";
import type {
    CloudKitField,
    CloudKitRecord,
    CloudKitScalar,
    CloudKitZoneId,
} from "@party-stack/cloudkit-client";
import type {
    OntologyIR,
    OntologyObject,
    TypeDef,
} from "@party-stack/ontology";

function encodeIdentifierPart(value: string): string {
    const encoded = value.replace(
        /[^A-Za-z0-9_]/g,
        (character) =>
            `_x${character.codePointAt(0)!.toString(16)}_`
    );
    return /^[A-Za-z_]/.test(encoded) ? encoded : `_${encoded}`;
}

export function cloudKitRecordTypeForObjectType(
    objectType: string
): string {
    return `PS_${encodeIdentifierPart(objectType)}`;
}

export function cloudKitFieldNameForProperty(
    property: string
): string {
    return `ps_${encodeIdentifierPart(property)}`;
}

export function cloudKitRecordName(
    objectType: string,
    primaryKey: string | number
): string {
    const type = typeof primaryKey === "number" ? "n" : "s";
    return `${encodeIdentifierPart(objectType)}:${type}:${encodeURIComponent(String(primaryKey))}`;
}

export function cloudKitPrimaryKeyFromRecordName(
    objectType: string,
    recordName: string
): string | number | undefined {
    const prefix = `${encodeIdentifierPart(objectType)}:`;
    if (!recordName.startsWith(prefix)) return undefined;
    const remainder = recordName.slice(prefix.length);
    const separator = remainder.indexOf(":");
    if (separator < 0) return undefined;
    const type = remainder.slice(0, separator);
    const value = decodeURIComponent(
        remainder.slice(separator + 1)
    );
    if (type === "s") return value;
    if (type !== "n") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

export function encodeCloudKitObject(options: {
    ir: OntologyIR;
    objectType: string;
    primaryKey: string;
    object: OntologyObject;
    zone: CloudKitZoneId;
    recordChangeTag?: string;
}): CloudKitRecord {
    const objectType = options.ir.objectTypes.find(
        (candidate) => candidate.name === options.objectType
    );
    if (!objectType) {
        throw new Error(
            `Unknown object type "${options.objectType}".`
        );
    }
    const primaryKey = options.object[options.primaryKey];
    if (
        typeof primaryKey !== "string" &&
        typeof primaryKey !== "number"
    ) {
        throw new Error(
            `${options.objectType} object is missing primary key "${options.primaryKey}".`
        );
    }
    const encoded = encode({
        ir: options.ir,
        target: { kind: "object", name: options.objectType },
        value: options.object,
    }) as Record<string, unknown>;
    const fields = Object.fromEntries(
        objectType.properties.flatMap((property) => {
            const value = encoded[property.name];
            if (value === undefined || value === null) return [];
            return [
                [
                    cloudKitFieldNameForProperty(property.name),
                    encodePropertyValue({
                        ir: options.ir,
                        type: property.type,
                        value,
                        zone: options.zone,
                    }),
                ],
            ];
        })
    );
    return {
        recordName: cloudKitRecordName(
            options.objectType,
            primaryKey
        ),
        recordType: cloudKitRecordTypeForObjectType(
            options.objectType
        ),
        recordChangeTag: options.recordChangeTag,
        fields,
    };
}

export function decodeCloudKitObject(options: {
    ir: OntologyIR;
    objectType: string;
    record: CloudKitRecord;
}): OntologyObject {
    const objectType = options.ir.objectTypes.find(
        (candidate) => candidate.name === options.objectType
    );
    if (!objectType) {
        throw new Error(
            `Unknown object type "${options.objectType}".`
        );
    }
    const encoded = Object.fromEntries(
        objectType.properties.flatMap((property) => {
            const field =
                options.record.fields[
                    cloudKitFieldNameForProperty(property.name)
                ];
            return field
                ? [
                      [
                          property.name,
                          decodePropertyValue({
                              ir: options.ir,
                              type: property.type,
                              field,
                          }),
                      ],
                  ]
                : [];
        })
    );
    return decode({
        ir: options.ir,
        target: { kind: "object", name: options.objectType },
        value: encoded,
    }) as OntologyObject;
}

function resolvedType(ir: OntologyIR, type: TypeDef): TypeDef {
    const resolved = resolveType(ir, type);
    return resolved.kind === "optional"
        ? resolvedType(ir, resolved.value.type)
        : resolved;
}

function encodeScalar(options: {
    ir: OntologyIR;
    type: TypeDef;
    value: unknown;
    zone: CloudKitZoneId;
}): CloudKitScalar | undefined {
    const type = resolvedType(options.ir, options.type);
    switch (type.kind) {
        case "string":
            return { type: "string", value: String(options.value) };
        case "boolean":
            return {
                type: "boolean",
                value: Boolean(options.value),
            };
        case "integer":
            return {
                type: "int64",
                value: String(options.value),
            };
        case "float":
        case "double":
            return {
                type: "double",
                value: Number(options.value),
            };
        case "date":
            return {
                type: "date",
                value: `${String(options.value).slice(0, 10)}T00:00:00.000Z`,
            };
        case "timestamp":
            return {
                type: "date",
                value: String(options.value),
            };
        case "geopoint": {
            const point = options.value as {
                lat: number;
                lon: number;
            };
            return {
                type: "location",
                value: {
                    latitude: point.lat,
                    longitude: point.lon,
                },
            };
        }
        case "objectReference": {
            if (
                typeof options.value !== "string" &&
                typeof options.value !== "number"
            ) {
                return undefined;
            }
            return {
                type: "reference",
                value: {
                    recordName: cloudKitRecordName(
                        type.value.objectType,
                        options.value
                    ),
                    zone: options.zone,
                },
            };
        }
        case "attachment": {
            const id = (
                options.value as { id?: unknown } | undefined
            )?.id;
            return typeof id === "string"
                ? {
                      type: "reference",
                      value: {
                          recordName: `Attachment:${encodeURIComponent(id)}`,
                          zone: options.zone,
                      },
                  }
                : undefined;
        }
        default:
            return undefined;
    }
}

function encodePropertyValue(options: {
    ir: OntologyIR;
    type: TypeDef;
    value: unknown;
    zone: CloudKitZoneId;
}): CloudKitField {
    const scalar = encodeScalar(options);
    if (scalar) return scalar;
    const type = resolvedType(options.ir, options.type);
    if (type.kind === "list" && Array.isArray(options.value)) {
        const values = options.value.map((value) =>
            encodeScalar({
                ...options,
                type: type.value.elementType,
                value,
            })
        );
        if (values.every((value) => value !== undefined)) {
            return {
                type: "list",
                value: values as CloudKitScalar[],
            };
        }
    }
    return {
        type: "string",
        value: JSON.stringify(options.value),
    };
}

function decodeScalar(options: {
    ir: OntologyIR;
    type: TypeDef;
    field: CloudKitScalar;
}): unknown {
    const type = resolvedType(options.ir, options.type);
    switch (type.kind) {
        case "string":
            return options.field.value;
        case "boolean":
            return Boolean(options.field.value);
        case "integer":
        case "float":
        case "double":
            return Number(options.field.value);
        case "date":
            return String(options.field.value).slice(0, 10);
        case "timestamp":
            return options.field.value;
        case "geopoint":
            return options.field.type === "location"
                ? {
                      lat: options.field.value.latitude,
                      lon: options.field.value.longitude,
                  }
                : undefined;
        case "objectReference":
            return options.field.type === "reference"
                ? cloudKitPrimaryKeyFromRecordName(
                      type.value.objectType,
                      options.field.value.recordName
                  )
                : undefined;
        case "attachment":
            if (options.field.type !== "reference") {
                return undefined;
            }
            return {
                id: decodeURIComponent(
                    options.field.value.recordName.replace(
                        /^Attachment:/,
                        ""
                    )
                ),
            };
        default:
            return options.field.value;
    }
}

function decodePropertyValue(options: {
    ir: OntologyIR;
    type: TypeDef;
    field: CloudKitField;
}): unknown {
    const type = resolvedType(options.ir, options.type);
    if (type.kind === "list" && options.field.type === "list") {
        return options.field.value.map((field) =>
            decodeScalar({
                ir: options.ir,
                type: type.value.elementType,
                field,
            })
        );
    }
    if (options.field.type === "string") {
        const scalar = encodeScalar({
            ir: options.ir,
            type: options.type,
            value: options.field.value,
            zone: { zoneName: "" },
        });
        if (!scalar) return JSON.parse(options.field.value) as unknown;
    }
    if (options.field.type === "list") return options.field.value;
    return decodeScalar({
        ir: options.ir,
        type: options.type,
        field: options.field,
    });
}

export function cloudKitSchemaTypeForOntologyType(
    ir: OntologyIR,
    typeDef: TypeDef
): string {
    const type = resolvedType(ir, typeDef);
    switch (type.kind) {
        case "string":
            return "STRING";
        case "boolean":
            return "BOOLEAN";
        case "integer":
            return "INT64";
        case "float":
        case "double":
            return "DOUBLE";
        case "date":
        case "timestamp":
            return "TIMESTAMP";
        case "geopoint":
            return "LOCATION";
        case "attachment":
        case "objectReference":
            return "REFERENCE";
        case "list": {
            const element =
                cloudKitSchemaTypeForOntologyType(
                    ir,
                    type.value.elementType
                );
            return element === "STRING" ||
                element === "INT64" ||
                element === "DOUBLE" ||
                element === "TIMESTAMP" ||
                element === "LOCATION" ||
                element === "REFERENCE"
                ? `LIST<${element}>`
                : "STRING";
        }
        default:
            return "STRING";
    }
}

export const cloudKitOntologySchemaFields = {
    attachmentAsset: "asset",
    attachmentContentType: "contentType",
    attachmentName: "name",
    attachmentSize: "size",
} as const;
