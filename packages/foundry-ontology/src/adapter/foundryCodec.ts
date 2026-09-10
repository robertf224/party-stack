import { Temporal } from "temporal-polyfill";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology";
import {
    decodeFoundryMediaId,
    foundryMediaIdToReference,
    mediaReferenceToFoundryMediaId,
} from "./foundryMediaId.js";
import type { MediaReference } from "@osdk/foundry.core";
import type { AttachmentProperty, OntologyObjectV2 } from "@osdk/foundry.ontologies";

type FoundryObjectRecord = Record<string, unknown>;
/** @deprecated Use {@link FoundryCodec} instead. */
export type FoundryObjectDecoder = FoundryCodec;

/** @deprecated Use {@link createFoundryCodec} instead. */
export const createFoundryObjectDecoder = createFoundryCodec;

export interface FoundryCodec {
    decodeObject: (objectType: string, object: OntologyObjectV2 | FoundryObjectRecord) => FoundryObjectRecord;
    decodeEditObject: (objectType: string, object: FoundryObjectRecord) => FoundryObjectRecord;
    decodeValue: (type: TypeDef, value: unknown) => unknown;
    encodeValue: (type: TypeDef, value: unknown) => unknown;
}

export function createFoundryCodec(
    ir: OntologyIR,
    options?: {
        resolveMediaReference?: (id: string) => MediaReference | undefined;
    }
): FoundryCodec {
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

    const decodeValue = (
        type: TypeDef,
        value: unknown,
        context: { editHistory: boolean; optional: boolean } = {
            editHistory: false,
            optional: false,
        }
    ): unknown => {
        const resolvedType = resolveType(type);

        if (resolvedType.kind === "optional") {
            if (
                value === undefined ||
                value === null ||
                (context.editHistory && isNullEditHistoryValue(value))
            ) {
                return undefined;
            }
            return decodeValue(resolvedType.value.type, value, {
                ...context,
                optional: true,
            });
        }

        if (value === undefined || value === null) {
            return value;
        }
        if (context.editHistory) {
            value = unwrapEditHistoryValue(resolvedType, value);
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
                return decodeAttachment(value, resolvedType.value.meta, context.optional);
            case "objectReference":
                return value;
            case "list":
                return Array.isArray(value)
                    ? value.map((item) => decodeValue(resolvedType.value.elementType, item, context))
                    : value;
            case "map":
                if (!isPlainObject(value)) {
                    return value;
                }
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => [
                        decodeValue(resolvedType.value.keyType, key, context),
                        decodeValue(resolvedType.value.valueType, entryValue, context),
                    ])
                );
            case "struct":
                if (!isPlainObject(value)) {
                    return value;
                }
                return Object.fromEntries(
                    Object.entries(value).map(([key, entryValue]) => {
                        const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                        return [
                            key,
                            field ? decodeValue(field.type, entryValue, context) : entryValue,
                        ];
                    })
                );
            case "union":
            case "result":
                return value;
            case "ref":
                return decodeValue(resolveType(resolvedType), value);
        }
    };

    const decodeObjectType = (
        objectType: ObjectTypeDef,
        object: FoundryObjectRecord,
        editHistory = false
    ): FoundryObjectRecord => {
        return Object.fromEntries(
            Object.entries(object).map(([key, value]) => {
                const property = objectType.properties.find((candidate) => candidate.name === key);
                return [
                    key,
                    property
                        ? decodeValue(property.type, value, {
                              editHistory,
                              optional: false,
                          })
                        : value,
                ];
            })
        );
    };

    const encodeValue = (type: TypeDef, value: unknown): unknown => {
        if (value === undefined) return undefined;
        if (value === null) return null;

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
                return encodeAttachment(value, resolvedType.value.meta, options?.resolveMediaReference);
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
        decodeEditObject: (objectTypeName, object) => {
            const objectType = objectTypes.get(objectTypeName);
            if (!objectType) {
                return object;
            }

            return decodeObjectType(objectType, object, true);
        },
        decodeValue,
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

function isNullEditHistoryValue(value: unknown): boolean {
    return value === "NullPropertyValue{}";
}

function unwrapEditHistoryValue(type: TypeDef, value: unknown): unknown {
    if (
        isPlainObject(value) &&
        typeof value.type === "string" &&
        "value" in value &&
        [
            "stringValue",
            "integerValue",
            "doubleValue",
            "longValue",
            "booleanValue",
            "dateValue",
            "timestampValue",
        ].includes(value.type)
    ) {
        return value.value;
    }
    if (type.kind === "geopoint" && typeof value === "string") {
        const match =
            /^GeoPointPropertyValue\{latitude:\s*(-?[\d.]+),\s*longitude:\s*(-?[\d.]+)\}$/.exec(
                value
            );
        if (match) {
            return {
                lat: Number(match[1]),
                lon: Number(match[2]),
            };
        }
    }
    if (
        type.kind === "attachment" &&
        type.value.meta?.type !== "media" &&
        isPlainObject(value) &&
        value.type === "attachment" &&
        typeof value.attachment === "string"
    ) {
        return { rid: value.attachment };
    }
    if (
        type.kind === "attachment" &&
        type.value.meta?.type === "media" &&
        isPlainObject(value) &&
        value.type === "mediaReference" &&
        isPlainObject(value.mediaReference)
    ) {
        return value.mediaReference;
    }
    return value;
}

function decodeAttachment(
    value: unknown,
    meta: Record<string, unknown> | undefined,
    optional: boolean
): unknown {
    const decoded =
        meta?.type === "media" ? decodeMediaReference(value) : decodeFoundryAttachment(value);
    if (decoded !== undefined || optional) {
        return decoded;
    }
    throw new Error(
        `Invalid required Foundry ${meta?.type === "media" ? "media" : "attachment"} value.`
    );
}

function decodeFoundryAttachment(value: unknown): unknown {
    const attachment = value as Partial<AttachmentProperty>;
    if (typeof attachment?.rid !== "string") {
        return undefined;
    }
    return { id: attachment.rid };
}

function decodeMediaReference(value: unknown): unknown {
    if (
        !isPlainObject(value) ||
        typeof value.mimeType !== "string" ||
        !isPlainObject(value.reference) ||
        value.reference.type !== "mediaSetViewItem" ||
        !isPlainObject(value.reference.mediaSetViewItem)
    ) {
        return undefined;
    }
    const mediaReference = value as unknown as MediaReference;
    const id = mediaReferenceToFoundryMediaId(mediaReference);
    if (!decodeFoundryMediaId(id)) {
        return undefined;
    }
    return {
        id,
        type: mediaReference.mimeType,
    };
}

function encodeAttachment(
    value: unknown,
    meta?: Record<string, unknown>,
    resolveMediaReference?: (id: string) => MediaReference | undefined
): unknown {
    if (!isPlainObject(value)) {
        return value;
    }
    if (typeof value.id !== "string") {
        throw new Error("Invalid Foundry attachment value: expected an attachment with a string id.");
    }
    if (meta?.type !== "media") {
        return value.id;
    }
    const resolved = resolveMediaReference?.(value.id);
    if (resolved) return resolved;
    const id = decodeFoundryMediaId(value.id);
    if (!id) {
        throw new Error(`Invalid Foundry media attachment id "${value.id}".`);
    }
    if (typeof value.type !== "string") {
        throw new Error(`Foundry media attachment "${value.id}" is missing its MIME type.`);
    }
    return foundryMediaIdToReference(id, value.type);
}

function isPlainObject(value: unknown): value is FoundryObjectRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
