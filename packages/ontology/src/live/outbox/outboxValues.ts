import { Temporal } from "temporal-polyfill";
import type {
    OntologyActionRequest,
    OntologyOutboxEntry,
} from "./types.js";

const OUTBOX_VALUE_TYPE =
    "__party_stack_outbox_value_type__";

interface EncodedTemporalValue {
    [OUTBOX_VALUE_TYPE]:
        | "Temporal.Instant"
        | "Temporal.PlainDate";
    value: string;
}

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

export function encodeOutboxValue(
    value: unknown
): unknown {
    if (value instanceof Temporal.Instant) {
        return {
            [OUTBOX_VALUE_TYPE]:
                "Temporal.Instant",
            value: value.toString(),
        } satisfies EncodedTemporalValue;
    }
    if (value instanceof Temporal.PlainDate) {
        return {
            [OUTBOX_VALUE_TYPE]:
                "Temporal.PlainDate",
            value: value.toString(),
        } satisfies EncodedTemporalValue;
    }
    if (Array.isArray(value)) {
        return value.map(encodeOutboxValue);
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(
                ([key, entry]) => [
                    key,
                    encodeOutboxValue(entry),
                ]
            )
        );
    }
    return value;
}

export function decodeOutboxValue(
    value: unknown
): unknown {
    if (Array.isArray(value)) {
        return value.map(decodeOutboxValue);
    }
    if (!isPlainObject(value)) {
        return value;
    }
    if (
        value[OUTBOX_VALUE_TYPE] ===
            "Temporal.Instant" &&
        typeof value.value === "string"
    ) {
        return Temporal.Instant.from(value.value);
    }
    if (
        value[OUTBOX_VALUE_TYPE] ===
            "Temporal.PlainDate" &&
        typeof value.value === "string"
    ) {
        return Temporal.PlainDate.from(
            value.value
        );
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            decodeOutboxValue(entry),
        ])
    );
}

export function encodeOutboxRequest(
    request: OntologyActionRequest
): OntologyActionRequest {
    return {
        ...request,
        parameters: encodeOutboxValue(
            request.parameters
        ) as Record<string, unknown>,
    };
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
