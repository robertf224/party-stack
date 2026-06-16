import { Temporal } from "temporal-polyfill";
import { resolveType } from "./types.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";

type OntologyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is OntologyRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hydrateOntologyJsonValue(ir: OntologyIR, type: TypeDef, value: unknown): unknown {
    if (value === undefined || value === null) return value;
    const resolvedType = resolveType(ir, type);

    switch (resolvedType.kind) {
        case "timestamp":
            return typeof value === "string" ? Temporal.Instant.from(value) : value;
        case "date":
            return typeof value === "string" ? Temporal.PlainDate.from(value) : value;
        case "optional":
            return hydrateOntologyJsonValue(ir, resolvedType.value.type, value);
        case "list":
            return Array.isArray(value)
                ? value.map((item) => hydrateOntologyJsonValue(ir, resolvedType.value.elementType, item))
                : value;
        case "map":
            if (!isRecord(value)) return value;
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    hydrateOntologyJsonValue(ir, resolvedType.value.valueType, entry),
                ])
            );
        case "struct":
            if (!isRecord(value)) return value;
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => {
                    const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                    return [key, field ? hydrateOntologyJsonValue(ir, field.type, entry) : entry];
                })
            );
        default:
            return value;
    }
}

export function serializeOntologyJsonValue(ir: OntologyIR, type: TypeDef, value: unknown): unknown {
    if (value === undefined || value === null) return value;
    const resolvedType = resolveType(ir, type);

    switch (resolvedType.kind) {
        case "timestamp":
        case "date":
            return typeof value === "object" &&
                value !== null &&
                typeof (value as { toString?: unknown }).toString === "function"
                ? (value as { toString: () => string }).toString()
                : value;
        case "optional":
            return serializeOntologyJsonValue(ir, resolvedType.value.type, value);
        case "list":
            return Array.isArray(value)
                ? value.map((item) => serializeOntologyJsonValue(ir, resolvedType.value.elementType, item))
                : value;
        case "map":
            if (!isRecord(value)) return value;
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    serializeOntologyJsonValue(ir, resolvedType.value.valueType, entry),
                ])
            );
        case "struct":
            if (!isRecord(value)) return value;
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => {
                    const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                    return [key, field ? serializeOntologyJsonValue(ir, field.type, entry) : entry];
                })
            );
        default:
            return value;
    }
}

export function hydrateOntologyJsonObject(opts: {
    ir: OntologyIR;
    objectTypeName: string;
    object: OntologyRecord;
}): OntologyRecord {
    const objectType = opts.ir.objectTypes.find((candidate) => candidate.name === opts.objectTypeName);
    if (!objectType) return opts.object;
    return Object.fromEntries(
        Object.entries(opts.object).map(([key, value]) => {
            const property = objectType.properties.find((candidate) => candidate.name === key);
            return [key, property ? hydrateOntologyJsonValue(opts.ir, property.type, value) : value];
        })
    );
}

export function serializeOntologyJsonObject(opts: {
    ir: OntologyIR;
    objectTypeName: string;
    object: OntologyRecord;
}): OntologyRecord {
    const objectType = opts.ir.objectTypes.find((candidate) => candidate.name === opts.objectTypeName);
    if (!objectType) return opts.object;
    return Object.fromEntries(
        Object.entries(opts.object).map(([key, value]) => {
            const property = objectType.properties.find((candidate) => candidate.name === key);
            return [key, property ? serializeOntologyJsonValue(opts.ir, property.type, value) : value];
        })
    );
}
