import { Temporal } from "temporal-polyfill";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology";

type SalesforceObjectRecord = Record<string, unknown>;

export interface SalesforceCodec {
    decodeObject: (objectType: string, object: SalesforceObjectRecord) => SalesforceObjectRecord;
    decodeValue: (type: TypeDef, value: unknown) => unknown;
    encodeValue: (type: TypeDef, value: unknown) => unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAttributes(object: SalesforceObjectRecord): SalesforceObjectRecord {
    const { attributes, ...rest } = object;
    void attributes;
    return rest;
}

export function createSalesforceCodec(ir: OntologyIR): SalesforceCodec {
    const objectTypes = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    const namedTypes = new Map(ir.types.map((type) => [type.name, type.type]));

    const resolveType = (type: TypeDef, seen = new Set<string>()): TypeDef => {
        if (type.kind !== "ref") {
            return type;
        }

        const name = type.value.name;
        if (seen.has(name)) {
            throw new Error(`Circular ontology type reference "${name}".`);
        }

        const resolved = namedTypes.get(name);
        if (!resolved) {
            throw new Error(`Unknown ontology type reference "${name}".`);
        }

        return resolveType(resolved, new Set([...seen, name]));
    };

    const decodeValue = (type: TypeDef, value: unknown): unknown => {
        const resolvedType = resolveType(type);

        if (value === undefined || value === null) {
            if (resolvedType.kind === "optional") {
                return undefined;
            }
            return value;
        }

        switch (resolvedType.kind) {
            case "string":
                return value;
            case "boolean":
                return typeof value === "string" ? value === "true" : value;
            case "integer":
            case "float":
            case "double":
                return typeof value === "string" ? Number(value) : value;
            case "date":
                return typeof value === "string" ? Temporal.PlainDate.from(value) : value;
            case "timestamp":
                if (typeof value === "string") {
                    // Salesforce datetime wire format is typically ISO-8601.
                    return Temporal.Instant.from(value.endsWith("Z") || value.includes("+") ? value : `${value}Z`);
                }
                if (typeof value === "number") return Temporal.Instant.fromEpochMilliseconds(value);
                return value;
            case "geopoint":
                return decodeGeoPoint(value);
            case "objectReference":
                return value;
            case "list":
                if (typeof value === "string") {
                    // Multipicklist values are semicolon-delimited.
                    return value
                        .split(";")
                        .filter((entry) => entry.length > 0)
                        .map((item) => decodeValue(resolvedType.value.elementType, item));
                }
                return Array.isArray(value)
                    ? value.map((item) => decodeValue(resolvedType.value.elementType, item))
                    : value;
            case "map":
                if (!isPlainObject(value)) {
                    return value;
                }
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => [
                        decodeValue(resolvedType.value.keyType, key),
                        decodeValue(resolvedType.value.valueType, entryValue),
                    ])
                );
            case "struct":
                if (!isPlainObject(value)) {
                    return value;
                }
                return Object.fromEntries(
                    Object.entries(stripAttributes(value)).map(([key, entryValue]) => {
                        const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                        return [key, field ? decodeValue(field.type, entryValue) : entryValue];
                    })
                );
            case "optional":
                return decodeValue(resolvedType.value.type, value);
            case "attachment":
            case "union":
            case "result":
            case "unknown":
                return value;
            case "ref":
                return decodeValue(resolveType(resolvedType), value);
        }
    };

    const encodeValue = (type: TypeDef, value: unknown): unknown => {
        const resolvedType = resolveType(type);

        if (value === undefined || value === null) {
            return null;
        }

        switch (resolvedType.kind) {
            case "string":
            case "boolean":
            case "integer":
            case "float":
            case "double":
            case "objectReference":
            case "unknown":
                return value;
            case "date":
                if (value instanceof Temporal.PlainDate) return value.toString();
                if (value instanceof Date) return value.toISOString().slice(0, 10);
                return value;
            case "timestamp":
                if (value instanceof Temporal.Instant) return value.toString();
                if (value instanceof Date) return value.toISOString();
                return value;
            case "geopoint":
                return encodeGeoPoint(value);
            case "list":
                if (!Array.isArray(value)) return value;
                // Multipicklist wire format uses semicolon delimiters for string lists.
                if (resolvedType.value.elementType.kind === "string") {
                    return value
                        .map((item) => encodeValue(resolvedType.value.elementType, item))
                        .filter((item): item is string | number | boolean => {
                            return (
                                typeof item === "string" ||
                                typeof item === "number" ||
                                typeof item === "boolean"
                            );
                        })
                        .join(";");
                }
                return value.map((item) => encodeValue(resolvedType.value.elementType, item));
            case "map":
                if (!isPlainObject(value)) return value;
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => [
                        encodeValue(resolvedType.value.keyType, key),
                        encodeValue(resolvedType.value.valueType, entryValue),
                    ])
                );
            case "struct":
                if (!isPlainObject(value)) return value;
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => {
                        const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                        return [key, field ? encodeValue(field.type, entryValue) : entryValue];
                    })
                );
            case "optional":
                return encodeValue(resolvedType.value.type, value);
            case "attachment":
            case "union":
            case "result":
                return value;
            case "ref":
                return encodeValue(resolveType(resolvedType), value);
        }
    };

    const decodeObjectType = (
        objectType: ObjectTypeDef,
        object: SalesforceObjectRecord
    ): SalesforceObjectRecord => {
        const cleaned = stripAttributes(object);
        return Object.fromEntries(
            objectType.properties.map((property) => [
                property.name,
                decodeValue(property.type, cleaned[property.name]),
            ])
        );
    };

    return {
        decodeObject: (objectTypeName, object) => {
            const objectType = objectTypes.get(objectTypeName);
            if (!objectType) {
                throw new Error(`Unknown object type "${objectTypeName}".`);
            }
            return decodeObjectType(objectType, object);
        },
        decodeValue,
        encodeValue,
    };
}

function decodeGeoPoint(value: unknown): unknown {
    if (isPlainObject(value)) {
        const lat = value.latitude ?? value.lat;
        const lon = value.longitude ?? value.lon;
        if (typeof lat === "number" && typeof lon === "number") {
            return { lat, lon };
        }
    }
    return value;
}

function encodeGeoPoint(value: unknown): unknown {
    if (isPlainObject(value) && typeof value.lat === "number" && typeof value.lon === "number") {
        return {
            latitude: value.lat,
            longitude: value.lon,
        };
    }
    return value;
}
