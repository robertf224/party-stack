import { Temporal } from "temporal-polyfill";
import type {
    OntologyActionRequest,
    OntologyOutboxEntry,
} from "./types.js";

// Legacy decoder only: older outbox entries tagged Temporal parameters before
// coordination transport supported them. New writes store raw Temporal values.
// Retain this until old durable entries have been drained or migrated.
const OUTBOX_VALUE_TYPE =
    "__party_stack_outbox_value_type__";

function isPlainObject(
    value: unknown
): value is Record<string, unknown> {
    if (
        typeof value !== "object" ||
        value === null
    ) {
        return false;
    }
    const prototype = Object.getPrototypeOf(
        value
    ) as unknown;
    return (
        prototype === Object.prototype ||
        prototype === null
    );
}

export function decodeOutboxValue(
    value: unknown,
    seen = new WeakMap<object, unknown>()
): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
        const decoded: unknown[] = [];
        seen.set(value, decoded);
        decoded.length = value.length;
        for (const key of Object.keys(value)) Object.defineProperty(decoded, key, {
            value: decodeOutboxValue(Reflect.get(value, key), seen), enumerable: true, writable: true, configurable: true,
        });
        return decoded;
    }
    if (value instanceof Map) {
        const decoded = new Map<unknown, unknown>();
        seen.set(value, decoded);
        for (const [key, entry] of value) decoded.set(decodeOutboxValue(key, seen), decodeOutboxValue(entry, seen));
        return decoded;
    }
    if (value instanceof Set) {
        const decoded = new Set<unknown>();
        seen.set(value, decoded);
        for (const entry of value) decoded.add(decodeOutboxValue(entry, seen));
        return decoded;
    }
    if (!isPlainObject(value)) {
        return value;
    }
    if (
        value[OUTBOX_VALUE_TYPE] ===
            "Temporal.Instant" &&
        typeof value.value === "string"
    ) {
        const decoded = Temporal.Instant.from(value.value);
        seen.set(value, decoded);
        return decoded;
    }
    if (
        value[OUTBOX_VALUE_TYPE] ===
            "Temporal.PlainDate" &&
        typeof value.value === "string"
    ) {
        const decoded = Temporal.PlainDate.from(value.value);
        seen.set(value, decoded);
        return decoded;
    }
    const decoded: Record<string, unknown> = {};
    seen.set(value, decoded);
    for (const [key, entry] of Object.entries(value)) Object.defineProperty(decoded, key, {
        value: decodeOutboxValue(entry, seen), enumerable: true, writable: true, configurable: true,
    });
    return decoded;
}

export function decodeOutboxRequest(
    request: OntologyActionRequest
): OntologyActionRequest {
    return {
        ...request,
        parameters: decodeOutboxValue(
            request.parameters
        ) as Record<string, unknown>,
    };
}

export function decodeOutboxEntry(
    entry: OntologyOutboxEntry
): OntologyOutboxEntry {
    return {
        ...entry,
        request: decodeOutboxRequest(entry.request),
    };
}
