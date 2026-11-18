import { invariant } from "@bobbyfidz/panic";
import { Temporal } from "temporal-polyfill";
import { resolveType } from "../utils/types.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";
import type { OntologyObject } from "../model.js";
import type {
    OntologyActionParametersTarget,
    OntologyObjectTarget,
    OntologyQueryFunctionParametersTarget,
    OntologyQueryFunctionReturnTarget,
    OntologyTypeTarget,
} from "../utils/targets.js";

export type JsonTarget<IR extends OntologyIR> =
    | OntologyTypeTarget<IR>
    | OntologyObjectTarget<IR>
    | OntologyActionParametersTarget<IR>
    | OntologyQueryFunctionParametersTarget<IR>
    | OntologyQueryFunctionReturnTarget<IR>;

function assertRecord(value: unknown): asserts value is OntologyObject {
    invariant(typeof value === "object" && value !== null && !Array.isArray(value), "Expected JSON object.");
}

function assertArray(value: unknown): asserts value is unknown[] {
    invariant(Array.isArray(value), "Expected JSON array.");
}

function getNamedType(ir: OntologyIR, name: string): TypeDef {
    const namedType = ir.types.find((candidate) => candidate.name === name);
    invariant(namedType, `Unknown ontology type "${name}".`);
    return namedType.type;
}

function getObjectType(ir: OntologyIR, name: string): OntologyIR["objectTypes"][number] {
    const objectType = ir.objectTypes.find((candidate) => candidate.name === name);
    invariant(objectType, `Unknown object type "${name}".`);
    return objectType;
}

function getActionType(ir: OntologyIR, name: string): OntologyIR["actionTypes"][number] {
    const actionType = ir.actionTypes.find((candidate) => candidate.name === name);
    invariant(actionType, `Unknown action type "${name}".`);
    return actionType;
}

function getQueryFunctionType(ir: OntologyIR, name: string): OntologyIR["queryFunctionTypes"][number] {
    const queryFunctionType = ir.queryFunctionTypes.find((candidate) => candidate.name === name);
    invariant(queryFunctionType, `Unknown query function type "${name}".`);
    return queryFunctionType;
}

function resolveTargetType<IR extends OntologyIR>(ir: IR, target: JsonTarget<IR>): TypeDef | undefined {
    switch (target.kind) {
        case "type":
            return getNamedType(ir, target.name);
        case "object":
        case "actionParameters":
        case "queryFunctionParameters":
            return undefined;
        case "queryFunctionReturn":
            return getQueryFunctionType(ir, target.queryFunctionType).returnType;
    }
}

function variantType(type: Extract<TypeDef, { kind: "union" | "result" }>, value: OntologyObject): TypeDef {
    if (type.kind === "result") {
        invariant(value.kind === "ok" || value.kind === "err", "Expected a portable Result variant.");
        return value.kind === "ok" ? type.value.okType : type.value.errType;
    }
    const variant = type.value.variants.find((candidate) => candidate.name === value.kind);
    invariant(variant, "Unknown union variant.");
    return variant.type;
}

function encryptedHandle(value: unknown): OntologyObject {
    assertRecord(value);
    invariant(typeof value.ciphertext === "string", "Expected an encrypted value handle.");
    if (value.source === undefined) return { ciphertext: value.ciphertext };
    assertRecord(value.source);
    return {
        ciphertext: value.ciphertext,
        source: {
            objectType: value.source.objectType,
            primaryKey: value.source.primaryKey,
            property: value.source.property,
        },
    };
}

/** The one reserved key in `unknown` positions: `{"$type": kind, "value": …}` holds a value JSON can't express. */
const TYPE_KEY = "$type";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Encodes a value of any allowed type held in an `unknown` position, losslessly. JSON-native values (strings,
 * finite numbers, booleans, null, arrays, plain objects) stay as they are. A date or timestamp becomes
 * `{"$type": "date" | "timestamp", "value": "<ISO 8601>"}`. `$type` is reserved: a plain object that has it
 * can't be stored in an `unknown` position.
 */
export function encodeUnknown(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const temporal = Reflect.get(value, Symbol.toStringTag) as unknown;
    if (temporal === "Temporal.Instant") return { [TYPE_KEY]: "timestamp", value: String(value) };
    if (temporal === "Temporal.PlainDate") return { [TYPE_KEY]: "date", value: String(value) };
    if (Array.isArray(value)) return value.map(encodeUnknown);
    // Other objects (class instances) pass through as before.
    if (!isPlainObject(value)) return value;
    invariant(!Object.hasOwn(value, TYPE_KEY), `"${TYPE_KEY}" is reserved in unknown values.`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeUnknown(entry)]));
}

/**
 * Reads a `$type`-tagged scalar. Encoding only writes dates and timestamps this way, but any scalar kind is
 * accepted, so a value written with its declared type (say an integer) reads back too.
 */
function decodeTypedScalar(kind: unknown, value: unknown): unknown {
    const expect = (type: string) =>
        invariant(typeof value === type, `Expected a ${type} value for "${String(kind)}".`);
    switch (kind) {
        case "timestamp":
            expect("string");
            return Temporal.Instant.from(value as string);
        case "date":
            expect("string");
            return Temporal.PlainDate.from(value as string);
        case "string":
            expect("string");
            return value;
        case "boolean":
            expect("boolean");
            return value;
        case "integer":
        case "float":
        case "double":
            expect("number");
            return value;
        default:
            throw new Error(`Unsupported "${TYPE_KEY}" in an unknown value: ${JSON.stringify(kind)}.`);
    }
}

/** Reverses {@link encodeUnknown}. JSON without `$type`, including JSON written before it existed, reads as itself. */
export function decodeUnknown(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decodeUnknown);
    if (!isPlainObject(value)) return value;
    if (Object.hasOwn(value, TYPE_KEY)) return decodeTypedScalar(value[TYPE_KEY], value.value);
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, decodeUnknown(entry)]));
}

function decodeValue(ir: OntologyIR, type: TypeDef, value: unknown, normalizeOptionalNull = false): unknown {
    const resolvedType = resolveType(ir, type);
    if (value === undefined) return undefined;
    if (value === null) {
        return normalizeOptionalNull && resolvedType.kind === "optional" ? undefined : null;
    }

    switch (resolvedType.kind) {
        case "encrypted":
            return encryptedHandle(value);
        case "union":
        case "result":
            assertRecord(value);
            return {
                kind: value.kind,
                value: decodeValue(ir, variantType(resolvedType, value), value.value, normalizeOptionalNull),
            };
        case "timestamp":
            return typeof value === "string" ? Temporal.Instant.from(value) : value;
        case "date":
            return typeof value === "string" ? Temporal.PlainDate.from(value) : value;
        case "unknown":
            return decodeUnknown(value);
        case "optional":
            return decodeValue(ir, resolvedType.value.type, value, normalizeOptionalNull);
        case "list":
            assertArray(value);
            return value.map((item) =>
                decodeValue(ir, resolvedType.value.elementType, item, normalizeOptionalNull)
            );
        case "map":
            assertRecord(value);
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    decodeValue(ir, resolvedType.value.valueType, entry, normalizeOptionalNull),
                ])
            );
        case "struct":
            assertRecord(value);
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => {
                    const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                    return [key, field ? decodeValue(ir, field.type, entry, normalizeOptionalNull) : entry];
                })
            );
        default:
            return value;
    }
}

function encodeValue(ir: OntologyIR, type: TypeDef, value: unknown): unknown {
    if (value === undefined || value === null) return value;
    const resolvedType = resolveType(ir, type);

    switch (resolvedType.kind) {
        case "encrypted":
            return encryptedHandle(value);
        case "union":
        case "result":
            assertRecord(value);
            return {
                kind: value.kind,
                value: encodeValue(ir, variantType(resolvedType, value), value.value),
            };
        case "timestamp":
        case "date":
            invariant(
                typeof value === "object" &&
                    value !== null &&
                    typeof (value as { toString?: unknown }).toString === "function",
                `Expected ${resolvedType.kind} value.`
            );
            return (value as { toString: () => string }).toString();
        case "unknown":
            return encodeUnknown(value);
        case "optional":
            return encodeValue(ir, resolvedType.value.type, value);
        case "list":
            assertArray(value);
            return value.map((item) => encodeValue(ir, resolvedType.value.elementType, item));
        case "map":
            assertRecord(value);
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    encodeValue(ir, resolvedType.value.valueType, entry),
                ])
            );
        case "struct":
            assertRecord(value);
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => {
                    const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                    return [key, field ? encodeValue(ir, field.type, entry) : entry];
                })
            );
        default:
            return value;
    }
}

function decodeObject(ir: OntologyIR, objectTypeName: string, value: unknown): OntologyObject {
    assertRecord(value);
    const objectType = getObjectType(ir, objectTypeName);
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            const property = objectType.properties.find((candidate) => candidate.name === key);
            return [key, property ? decodeValue(ir, property.type, entry, true) : entry];
        })
    );
}

function encodeObject(ir: OntologyIR, objectTypeName: string, value: unknown): OntologyObject {
    assertRecord(value);
    const objectType = getObjectType(ir, objectTypeName);
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            const property = objectType.properties.find((candidate) => candidate.name === key);
            return [key, property ? encodeValue(ir, property.type, entry) : entry];
        })
    );
}

function decodeParameters(
    ir: OntologyIR,
    parameters: { name: string; type: TypeDef }[],
    value: unknown
): OntologyObject {
    assertRecord(value);
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            const parameter = parameters.find((candidate) => candidate.name === key);
            return [key, parameter ? decodeValue(ir, parameter.type, entry) : entry];
        })
    );
}

function encodeParameters(
    ir: OntologyIR,
    parameters: { name: string; type: TypeDef }[],
    value: unknown
): OntologyObject {
    assertRecord(value);
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            const parameter = parameters.find((candidate) => candidate.name === key);
            return [key, parameter ? encodeValue(ir, parameter.type, entry) : entry];
        })
    );
}

export function decode<IR extends OntologyIR>(opts: {
    ir: IR;
    target: JsonTarget<IR>;
    value: unknown;
}): unknown {
    if (opts.target.kind === "object") {
        return decodeObject(opts.ir, opts.target.name, opts.value);
    }
    if (opts.target.kind === "actionParameters") {
        return decodeParameters(
            opts.ir,
            getActionType(opts.ir, opts.target.actionType).parameters,
            opts.value
        );
    }
    if (opts.target.kind === "queryFunctionParameters") {
        return decodeParameters(
            opts.ir,
            getQueryFunctionType(opts.ir, opts.target.queryFunctionType).parameters,
            opts.value
        );
    }
    return decodeValue(
        opts.ir,
        resolveTargetType(opts.ir, opts.target)!,
        opts.value,
        opts.target.kind === "queryFunctionReturn"
    );
}

export function encode<IR extends OntologyIR>(opts: {
    ir: IR;
    target: JsonTarget<IR>;
    value: unknown;
}): unknown {
    if (opts.target.kind === "object") {
        return encodeObject(opts.ir, opts.target.name, opts.value);
    }
    if (opts.target.kind === "actionParameters") {
        return encodeParameters(
            opts.ir,
            getActionType(opts.ir, opts.target.actionType).parameters,
            opts.value
        );
    }
    if (opts.target.kind === "queryFunctionParameters") {
        return encodeParameters(
            opts.ir,
            getQueryFunctionType(opts.ir, opts.target.queryFunctionType).parameters,
            opts.value
        );
    }
    return encodeValue(opts.ir, resolveTargetType(opts.ir, opts.target)!, opts.value);
}
