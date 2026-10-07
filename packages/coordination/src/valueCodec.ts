import { Temporal } from "temporal-polyfill";
import { COORDINATION_PROTOCOL_VERSION } from "./contracts.js";

const TAG = "__party_stack_coordination_value__";
const constructors = {
    "Temporal.Instant": Temporal.Instant,
    "Temporal.PlainDate": Temporal.PlainDate,
    "Temporal.PlainDateTime": Temporal.PlainDateTime,
    "Temporal.PlainMonthDay": Temporal.PlainMonthDay,
    "Temporal.PlainTime": Temporal.PlainTime,
    "Temporal.PlainYearMonth": Temporal.PlainYearMonth,
    "Temporal.ZonedDateTime": Temporal.ZonedDateTime,
    "Temporal.Duration": Temporal.Duration,
};

function temporalConstructor(kind: string) {
    return constructors[kind as keyof typeof constructors];
}

// Every ordinary record is wrapped, so application fields cannot collide with
// the wire tags. Per-call graph maps preserve cycles/aliases without retaining
// payloads after encoding or decoding. Native cloneable values stay native.
export function encodeCoordinationValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return seen.get(value);
    const prototype = Object.getPrototypeOf(value) as unknown;
    const kind = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
    if (prototype !== Object.prototype && prototype !== null && typeof kind === "string" && kind.startsWith("Temporal.")) {
        const constructor = temporalConstructor(kind);
        if (!constructor) throw new TypeError(`Unsupported coordination value: ${kind}`);
        const encoded = { [TAG]: "temporal", kind, value: constructor.prototype.toString.call(value) };
        seen.set(value, encoded);
        return encoded;
    }
    if (Array.isArray(value)) {
        const encoded: unknown[] = [];
        seen.set(value, encoded);
        // Preserve sparse arrays as well as explicit undefined entries.
        encoded.length = value.length;
        for (const key of Object.keys(value)) Object.defineProperty(encoded, key, {
            value: encodeCoordinationValue(Reflect.get(value, key), seen), enumerable: true, writable: true, configurable: true,
        });
        return encoded;
    }
    if (value instanceof Map) {
        const encoded = new Map<unknown, unknown>();
        seen.set(value, encoded);
        for (const [key, entry] of value) encoded.set(encodeCoordinationValue(key, seen), encodeCoordinationValue(entry, seen));
        return encoded;
    }
    if (value instanceof Set) {
        const encoded = new Set<unknown>();
        seen.set(value, encoded);
        for (const entry of value) encoded.add(encodeCoordinationValue(entry, seen));
        return encoded;
    }
    if (prototype === Object.prototype || prototype === null) {
        const entries: Record<string, unknown> = {};
        const encoded = { [TAG]: "record", value: entries };
        seen.set(value, encoded);
        for (const [key, entry] of Object.entries(value)) Object.defineProperty(entries, key, {
            value: encodeCoordinationValue(entry, seen), enumerable: true, writable: true, configurable: true,
        });
        return encoded;
    }
    return value;
}

export function decodeCoordinationValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
        const decoded: unknown[] = [];
        seen.set(value, decoded);
        decoded.length = value.length;
        for (const key of Object.keys(value)) Object.defineProperty(decoded, key, {
            value: decodeCoordinationValue(Reflect.get(value, key), seen), enumerable: true, writable: true, configurable: true,
        });
        return decoded;
    }
    if (value instanceof Map) {
        const decoded = new Map<unknown, unknown>();
        seen.set(value, decoded);
        for (const [key, entry] of value) decoded.set(decodeCoordinationValue(key, seen), decodeCoordinationValue(entry, seen));
        return decoded;
    }
    if (value instanceof Set) {
        const decoded = new Set<unknown>();
        seen.set(value, decoded);
        for (const entry of value) decoded.add(decodeCoordinationValue(entry, seen));
        return decoded;
    }
    if (TAG in value) {
        const record = value as Record<string, unknown>;
        if (record[TAG] === "temporal" && typeof record.kind === "string" && typeof record.value === "string") {
            const constructor = temporalConstructor(record.kind);
            if (!constructor) throw new TypeError(`Unsupported coordination value: ${record.kind}`);
            const decoded = constructor.from(record.value);
            seen.set(value, decoded);
            return decoded;
        }
        if (record[TAG] === "record" && typeof record.value === "object" && record.value !== null) {
            const decoded: Record<string, unknown> = {};
            seen.set(value, decoded);
            for (const [key, entry] of Object.entries(record.value)) Object.defineProperty(decoded, key, {
                value: decodeCoordinationValue(entry, seen), enumerable: true, writable: true, configurable: true,
            });
            return decoded;
        }
        throw new TypeError("Invalid coordination value encoding");
    }
    return value;
}

/** Clone a service value with the same Temporal support as remote coordination. */
export function cloneCoordinationValue<T>(value: T): T {
    return decodeCoordinationValue(structuredClone(encodeCoordinationValue(value))) as T;
}

// Keep routing and handshake fields visible, including for protocol mismatch
// handling. Only application payloads and successful results use the value codec.
function mapMessage(message: unknown, transform: (value: unknown) => unknown): unknown {
    if (typeof message !== "object" || message === null) return message;
    const record = message as Record<string, unknown>;
    if (record.v !== COORDINATION_PROTOCOL_VERSION) return message;
    return {
        ...record,
        ...("payload" in record ? { payload: transform(record.payload) } : {}),
        ...("result" in record ? { result: transform(record.result) } : {}),
    };
}

export function encodeCoordinationMessage(message: unknown): unknown {
    return mapMessage(message, encodeCoordinationValue);
}

export function decodeCoordinationMessage(message: unknown): unknown {
    return mapMessage(message, decodeCoordinationValue);
}
