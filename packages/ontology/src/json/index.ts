import { invariant } from "@bobbyfidz/panic";
import { Temporal } from "temporal-polyfill";
import { resolveType } from "../utils/types.js";
import type { OntologyIR, TypeDef } from "../ir/generated/types.js";
import type { OntologyObject } from "../utils/OntologyObject.js";
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

function decodeValue(ir: OntologyIR, type: TypeDef, value: unknown): unknown {
    if (value === undefined || value === null) return value;
    const resolvedType = resolveType(ir, type);

    switch (resolvedType.kind) {
        case "timestamp":
            return typeof value === "string" ? Temporal.Instant.from(value) : value;
        case "date":
            return typeof value === "string" ? Temporal.PlainDate.from(value) : value;
        case "optional":
            return decodeValue(ir, resolvedType.value.type, value);
        case "list":
            assertArray(value);
            return value.map((item) => decodeValue(ir, resolvedType.value.elementType, item));
        case "map":
            assertRecord(value);
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    decodeValue(ir, resolvedType.value.valueType, entry),
                ])
            );
        case "struct":
            assertRecord(value);
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => {
                    const field = resolvedType.value.fields.find((candidate) => candidate.name === key);
                    return [key, field ? decodeValue(ir, field.type, entry) : entry];
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
        case "timestamp":
        case "date":
            invariant(
                typeof value === "object" &&
                    value !== null &&
                    typeof (value as { toString?: unknown }).toString === "function",
                `Expected ${resolvedType.kind} value.`
            );
            return (value as { toString: () => string }).toString();
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
            return [key, property ? decodeValue(ir, property.type, entry) : entry];
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
        return decodeParameters(opts.ir, getActionType(opts.ir, opts.target.actionType).parameters, opts.value);
    }
    if (opts.target.kind === "queryFunctionParameters") {
        return decodeParameters(opts.ir, getQueryFunctionType(opts.ir, opts.target.queryFunctionType).parameters, opts.value);
    }
    return decodeValue(opts.ir, resolveTargetType(opts.ir, opts.target)!, opts.value);
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
        return encodeParameters(opts.ir, getActionType(opts.ir, opts.target.actionType).parameters, opts.value);
    }
    if (opts.target.kind === "queryFunctionParameters") {
        return encodeParameters(opts.ir, getQueryFunctionType(opts.ir, opts.target.queryFunctionType).parameters, opts.value);
    }
    return encodeValue(opts.ir, resolveTargetType(opts.ir, opts.target)!, opts.value);
}
