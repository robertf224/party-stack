import { Temporal } from "temporal-polyfill";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology";
import type { AttachmentProperty, OntologyObjectV2 } from "@osdk/foundry.ontologies";

type FoundryObjectRecord = Record<string, unknown>;
type MediaReferencePropertyValue = {
    mimeType: string;
    reference: {
        type: "mediaSetViewItem";
        mediaSetViewItem: {
            mediaItemRid: string;
        };
    };
};

/** @deprecated Use {@link FoundryCodec} instead. */
export type FoundryObjectDecoder = FoundryCodec;

/** @deprecated Use {@link createFoundryCodec} instead. */
export const createFoundryObjectDecoder = createFoundryCodec;

export interface FoundryCodec {
    decodeObject: (objectType: string, object: OntologyObjectV2 | FoundryObjectRecord) => FoundryObjectRecord;
    encodeValue: (type: TypeDef, value: unknown) => unknown;
}

export function createFoundryCodec(ir: OntologyIR): FoundryCodec {
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
                if (typeof value === "string") return Temporal.Instant.from(value);
                if (typeof value === "number") return Temporal.Instant.fromEpochMilliseconds(value);
                return value;
            case "geopoint":
                return decodeGeoPoint(value);
            case "attachment":
                return decodeAttachment(value, resolvedType.value.meta);
            case "objectReference":
                return value;
            case "list":
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
                    Object.entries(value).map(([key, entryValue]) => {
                        const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                        return [key, field ? decodeValue(field.type, entryValue) : entryValue];
                    })
                );
            case "optional":
                return decodeValue(resolvedType.value.type, value);
            case "union":
            case "result":
                return value;
            case "ref":
                return decodeValue(resolveType(resolvedType), value);
        }
    };

    const decodeObjectType = (
        objectType: ObjectTypeDef,
        object: FoundryObjectRecord
    ): FoundryObjectRecord => {
        return Object.fromEntries(
            Object.entries(object).map(([key, value]) => {
                const property = objectType.properties.find((candidate) => candidate.name === key);
                return [key, property ? decodeValue(property.type, value) : value];
            })
        );
    };

    const encodeValue = (type: TypeDef, value: unknown): unknown => {
        if (value === undefined || value === null) {
            return undefined;
        }

        const resolvedType = resolveType(type);

        switch (resolvedType.kind) {
            case "string":
            case "boolean":
            case "integer":
            case "float":
            case "double":
                return value;
            case "date":
                return value instanceof Temporal.PlainDate ? value.toString() : value;
            case "timestamp":
                if (value instanceof Temporal.Instant) return value.toString();
                if (value instanceof Temporal.PlainDateTime) return value.toString();
                return value;
            case "geopoint":
                return encodeGeoPoint(value);
            case "attachment":
                return isPlainObject(value) && typeof value.id === "string" ? value.id : value;
            case "objectReference":
            case "unknown":
                return value;
            case "list":
                return Array.isArray(value)
                    ? value.map((item) => encodeValue(resolvedType.value.elementType, item))
                    : value;
            case "map":
                if (!isPlainObject(value)) return value;
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => [
                        key,
                        encodeValue(resolvedType.value.valueType, entryValue),
                    ])
                );
            case "struct":
                if (!isPlainObject(value)) return value;
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => {
                        const field = resolvedType.value.fields.find((f) => f.name === key);
                        return [key, field ? encodeValue(field.type, entryValue) : entryValue];
                    })
                );
            case "optional":
                return encodeValue(resolvedType.value.type, value);
            case "union":
            case "result":
                return value;
            case "ref":
                return encodeValue(resolveType(resolvedType), value);
        }
    };

    return {
        decodeObject: (objectTypeName, object) => {
            const objectType = objectTypes.get(objectTypeName);
            if (!objectType) {
                return object;
            }

            return decodeObjectType(objectType, object);
        },
        encodeValue,
    };
}

function encodeGeoPoint(value: unknown): unknown {
    if (isPlainObject(value) && typeof value.lat === "number" && typeof value.lon === "number") {
        return { type: "Point", coordinates: [value.lon, value.lat] };
    }
    return value;
}

function decodeGeoPoint(value: unknown): unknown {
    if (isPlainObject(value) && value.type === "Point" && Array.isArray(value.coordinates)) {
        const coordinates = value.coordinates as unknown[];
        const lon = coordinates[0];
        const lat = coordinates[1];
        if (typeof lat === "number" && typeof lon === "number") {
            return { lat, lon };
        }
    }

    if (isPlainObject(value) && typeof value.lat === "number" && typeof value.lon === "number") {
        return value;
    }

    return value;
}

function decodeAttachment(value: unknown, meta?: Record<string, unknown>): unknown {
    return meta?.type === "media" ? decodeMediaReference(value) : decodeFoundryAttachment(value);
}

function decodeFoundryAttachment(value: unknown): unknown {
    const attachment = value as AttachmentProperty;
    return { id: attachment.rid };
}

function decodeMediaReference(value: unknown): unknown {
    const mediaReference = value as MediaReferencePropertyValue;
    return {
        id: mediaReference.reference.mediaSetViewItem.mediaItemRid,
        type: mediaReference.mimeType,
    };
}

function isPlainObject(value: unknown): value is FoundryObjectRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
