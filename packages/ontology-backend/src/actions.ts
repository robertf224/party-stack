import { booleanValue, evaluateOperator } from "@party-stack/ontology-spec/query";
import {
    getAtPath,
    setAtPath,
    resolveType,
    unwrapType,
    unwrapValueType,
    resolveRelatedLink,
    isRelatedFromForeignKeySource,
    resolveLookupReference,
    certain,
} from "@party-stack/ontology-spec/utils";
import { eq, field } from "@party-stack/ontology-storage";
import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { BackendError } from "./errors.js";
import { executeQuery } from "./query.js";
import type { ActionRequest } from "./index.js";
import type { OwnedReadTransaction, OwnedTransaction } from "./owned.js";
import type {
    Expression,
    OntologyIR,
    ObjectTypeDef,
    TypeDef,
    QueryDocument,
} from "@party-stack/ontology-spec";
import type { Uncertain } from "@party-stack/ontology-spec/utils";
import type { Key } from "@party-stack/ontology-storage";

export type ActionMutator = (
    tx: ActionTransaction,
    request: ActionRequest,
    context: Record<string, unknown>
) => Effect.Effect<unknown, BackendError>;
export interface ActionTransaction extends OwnedTransaction {
    readonly query: (
        document: QueryDocument,
        options?: { readonly inputs?: Record<string, unknown> }
    ) => Effect.Effect<Record<string, unknown>, BackendError>;
}
export type ActionMutatorRegistry = Readonly<Record<string, ActionMutator>>;
export interface ActionExecutionOptions {
    readonly ir: OntologyIR;
    readonly tx: OwnedTransaction;
    readonly request: ActionRequest;
    readonly context?: Record<string, unknown>;
    readonly mutators?: ActionMutatorRegistry;
    readonly resolveOnly?: boolean;
}
const failure = (message: string, kind: BackendError["kind"] = "InvalidRequest", cause?: unknown) =>
    new BackendError({ operation: "action.execute", kind, retryable: false, message, cause });
const scalar = <A>(compute: () => A) =>
    Effect.try({
        try: compute,
        catch: (cause) =>
            failure(
                cause instanceof Error ? cause.message : "Invalid expression values.",
                "InvalidRequest",
                cause
            ),
    });
const defect = (cause: unknown) =>
    Effect.fail(
        cause instanceof BackendError ? cause : failure("Action execution failed.", "Internal", cause)
    );
class Reference {
    constructor(
        readonly objectType: string,
        readonly key: unknown,
        readonly optional: boolean
    ) {}
}
class Loaded {
    constructor(
        readonly objectType: string,
        readonly value: Record<string, unknown>
    ) {}
}
/** Internal partial-default evaluation; never part of the backend error contract. */
class UnresolvedInput extends Schema.TaggedError<UnresolvedInput>()("UnresolvedActionInput", {
    parameter: Schema.String,
}) {}
const unwrapped = (value: unknown): unknown => {
    if (value instanceof Reference) return value.key;
    if (value instanceof Loaded) return value.value;
    if (Array.isArray(value)) return value.map(unwrapped);
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapped(v)]));
    return value;
};
const keyOf = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
        ? Effect.succeed(value)
        : Effect.fail(failure("Object reference requires a primary key."));

/** Portable action expressions read only the supplied transaction. No collection, remote demand or runtime lifecycle. */
export const actionExpressions = (options: {
    readonly ir: OntologyIR;
    readonly tx: OwnedReadTransaction;
    readonly request: ActionRequest;
    readonly context?: Record<string, unknown>;
    readonly resolveParameter?: (name: string) => Effect.Effect<unknown, BackendError>;
}) => {
    const { ir, tx, request } = options;
    const action = ir.actionTypes.find((a) => a.name === request.name);
    const parameters: Record<string, unknown> = { ...request.parameters };
    const resolving = new Set<string>();
    const object = (name: string) => {
        const type = ir.objectTypes.find((t) => t.name === name);
        return type
            ? Effect.succeed(type)
            : Effect.fail(failure(`Unknown object type "${name}".`, "InvalidConfiguration"));
    };
    const resolveParameter = Effect.fnUntraced(function* (
        name: string
    ): Effect.fn.Return<unknown, BackendError | UnresolvedInput> {
        if (parameters[name] !== undefined) return parameters[name];
        const parameter = action?.parameters.find((p) => p.name === name);
        if (!parameter?.defaultValue) return undefined;
        if (resolving.has(name))
            return yield* failure(`Circular action parameter default for "${name}".`, "InvalidConfiguration");
        resolving.add(name);
        return yield* raw(parameter.defaultValue, ["parameter", name], new Map()).pipe(
            Effect.map(unwrapped),
            Effect.tap((value) =>
                Effect.sync(() => {
                    if (value !== undefined) parameters[name] = value;
                })
            ),
            Effect.ensuring(Effect.sync(() => resolving.delete(name)))
        );
    });
    const raw = Effect.fnUntraced(function* (
        e: Expression,
        location: readonly (string | number)[],
        locals: ReadonlyMap<string, unknown>
    ): Effect.fn.Return<unknown, BackendError | UnresolvedInput> {
        const child = (node: Expression, segment: string) => raw(node, [...location, segment], locals);
        switch (e.kind) {
            case "literal":
                return e.value.value;
            case "inputReference": {
                const value = yield* (
                    options.resolveParameter?.(e.value.name) ?? resolveParameter(e.value.name)
                );
                const parameter = action?.parameters.find((p) => p.name === e.value.name);
                if (!parameter) return yield* failure(`Unknown action parameter "${e.value.name}".`);
                const { type, isOptional } = unwrapType(resolveType(ir, parameter.type));
                if (value === undefined && !isOptional)
                    return yield* new UnresolvedInput({ parameter: parameter.name });
                return type.kind === "objectReference"
                    ? new Reference(type.value.objectType, value, isOptional)
                    : value;
            }
            case "contextReference":
                return options.context?.[e.value.name];
            case "localReference":
                if (!locals.has(e.value.name))
                    return yield* failure(`Unknown expression binding "${e.value.name}".`);
                return locals.get(e.value.name);
            case "getAt": {
                const source = yield* child(e.value.source, "source");
                if (source instanceof Reference)
                    return yield* failure(
                        "An object reference must be looked up before accessing properties."
                    );
                return getAtPath(source instanceof Loaded ? source.value : source, e.value.path);
            }
            case "lookup": {
                const reference = resolveLookupReference(ir, e.value.reference, action?.parameters);
                if (!reference)
                    return yield* failure("Lookup requires an input/context object-reference path.");
                const valueKey = unwrapped(yield* child(e.value.reference, "reference"));
                if (valueKey == null) return undefined;
                const key = yield* keyOf(valueKey);
                const value = yield* tx.get(reference.objectType, key);
                if (!value && !reference.optional)
                    return yield* failure(`Missing loaded "${reference.objectType}" object.`, "NotFound");
                return value ? new Loaded(reference.objectType, value) : undefined;
            }
            case "related": {
                const source = yield* child(e.value.source, "source");
                if (!(source instanceof Loaded))
                    return yield* failure("Related requires an ontology object.");
                const link = resolveRelatedLink(ir, source.objectType, e.value.link);
                if (!link) return yield* failure(`Unknown relationship "${e.value.link}".`);
                const ownFK = isRelatedFromForeignKeySource(link, source.objectType, e.value.link);
                if (!ownFK && link.cardinality === "many")
                    return yield* failure(
                        "To-many related expressions are not supported in action execution yet.",
                        "NotImplemented"
                    );
                const sourceType = yield* object(source.objectType);
                const target = yield* object(ownFK ? link.target.objectType : link.source.objectType);
                const key = ownFK
                    ? getAtPath(source.value, link.foreignKey.split("."))
                    : source.value[sourceType.primaryKey];
                if (key == null) return undefined;
                const rows = yield* tx.loadSubset(target.name, {
                    where: eq(
                        field(...(ownFK ? target.primaryKey : link.foreignKey).split(".")),
                        yield* keyOf(key)
                    ),
                    limit: 2,
                });
                if (rows.length > 1)
                    return yield* failure(
                        "To-one relationship returned multiple objects.",
                        "InvalidResponse"
                    );
                return rows[0] ? new Loaded(target.name, rows[0].value) : undefined;
            }
            case "struct": {
                const entries = [];
                for (const f of e.value.fields)
                    entries.push([f.name, yield* raw(f.value, [...location, "field", f.name], locals)]);
                return Object.fromEntries(entries);
            }
            case "map": {
                const source = yield* child(e.value.source, "source");
                if (source === undefined) return undefined;
                if (!Array.isArray(source)) return yield* failure("Map source must resolve to a list.");
                return yield* Effect.forEach(source, (item, index) =>
                    raw(
                        e.value.body,
                        [...location, "item", index],
                        new Map([...locals, [e.value.binding, item]])
                    )
                );
            }
            case "uuid": {
                if (!request.replay) return crypto.randomUUID();
                const digest = yield* Effect.tryPromise({
                    try: () =>
                        crypto.subtle.digest(
                            "SHA-256",
                            new TextEncoder().encode(JSON.stringify([request.replay!.seed, location]))
                        ),
                    catch: (cause) => failure("Could not derive replay UUID.", "Internal", cause),
                });
                const bytes = new Uint8Array(digest).slice(0, 16);
                bytes[6] = (bytes[6]! & 0x0f) | 0x80;
                bytes[8] = (bytes[8]! & 0x3f) | 0x80;
                const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
                return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            }
            case "now":
                return yield* Effect.try({
                    try: () =>
                        request.replay ? Temporal.Instant.from(request.replay.now) : Temporal.Now.instant(),
                    catch: (cause) => failure("Invalid replay time.", "InvalidRequest", cause),
                });
            case "case": {
                for (const [index, branch] of e.value.branches.entries()) {
                    const condition = unwrapped(
                        yield* raw(branch.condition, [...location, "branch", index, "condition"], locals)
                    );
                    if (yield* scalar(() => booleanValue(condition)))
                        return yield* raw(branch.result, [...location, "branch", index, "result"], locals);
                }
                return yield* child(e.value.else, "else");
            }
            case "exists":
                return yield* failure("EXISTS is not supported in action expressions yet.", "NotImplemented");
            default: {
                const nodes =
                    e.kind === "not"
                        ? [e.value.expression]
                        : "expressions" in e.value
                          ? e.value.expressions
                          : [e.value.left, e.value.right];
                const values: Uncertain<unknown>[] = [];
                for (const [index, node] of nodes.entries()) {
                    const resolved = yield* raw(node, [...location, "operand", index], locals);
                    const value = unwrapped(resolved);
                    // Preserve reference/entity identity for subsequent traversal.
                    if (e.kind === "coalesce" && value != null) return resolved;
                    values.push(certain(value));
                    if (
                        (e.kind === "and" || e.kind === "or") &&
                        (yield* scalar(() => booleanValue(value))) === (e.kind === "or")
                    )
                        break;
                }
                const result = yield* scalar(() => evaluateOperator(e.kind, values));
                // All action inputs are concrete; uncertainty belongs to draft/query evaluation.
                if (!result.certain) return yield* failure("Action expression depends on unavailable data.");
                return result.value;
            }
        }
    });
    const evaluate = (expression: Expression, location: readonly (string | number)[] = []) =>
        raw(expression, location, new Map()).pipe(
            Effect.map(unwrapped),
            Effect.catchTag("UnresolvedActionInput", (error) =>
                Effect.fail(failure(`Missing action parameter "${error.parameter}".`))
            ),
            Effect.catchDefect(defect)
        );
    return {
        evaluate,
        resolve: Effect.gen(function* () {
            if (!action) return yield* failure("Action is unavailable.", "NotFound");
            for (const parameter of action.parameters)
                yield* resolveParameter(parameter.name).pipe(
                    Effect.catchTag("UnresolvedActionInput", () => Effect.void)
                );
            return parameters;
        }).pipe(Effect.catchDefect(defect)),
    };
};

const targetType = (ir: OntologyIR, object: ObjectTypeDef, path: readonly string[]): TypeDef | undefined => {
    let current: TypeDef | undefined = { kind: "struct", value: { fields: object.properties } };
    for (const segment of path) {
        if (!current) break;
        current = resolveType(ir, current);
        while (current.kind === "optional") current = resolveType(ir, current.value.type);
        current =
            current.kind === "struct"
                ? current.value.fields.find((f) => f.name === segment)?.type
                : current.kind === "map"
                  ? current.value.valueType
                  : current.kind === "list"
                    ? current.value.elementType
                    : undefined;
    }
    return current;
};
/** Shared authoritative execution and local replay. Transaction/commit ownership stays with the caller. */
export const executeAction = Effect.fn("Action.execute")(function* (options: ActionExecutionOptions) {
    const { ir, tx, request } = options;
    const action = ir.actionTypes.find((a) => a.name === request.name);
    if (!action) return yield* failure("Action is unavailable.", "NotFound");
    const expressions = actionExpressions(options);
    const parameters = yield* expressions.resolve;
    if (options.resolveOnly) return { parameters, result: undefined };
    for (const [index, step] of action.logic.entries()) {
        let type: ObjectTypeDef | undefined;
        let key: Key | undefined;
        if (step.kind === "createObject") type = ir.objectTypes.find((t) => t.name === step.value.objectType);
        else {
            const parameter = action.parameters.find((p) => p.name === step.value.object.name);
            const resolved = parameter && unwrapType(resolveType(ir, parameter.type)).type;
            type =
                resolved?.kind === "objectReference"
                    ? ir.objectTypes.find((t) => t.name === resolved.value.objectType)
                    : undefined;
            key = yield* keyOf(parameters[step.value.object.name]);
        }
        if (!type)
            return yield* failure("Action logic references an unknown object type.", "InvalidConfiguration");
        if (step.kind === "deleteObject") {
            yield* tx.delete(type.name, key!);
            continue;
        }
        const changes = [];
        for (const assignment of step.value.values) {
            const value = yield* expressions.evaluate(assignment.value, [
                "logic",
                index,
                ...assignment.property,
            ]);
            if (value === undefined) continue;
            const target = targetType(ir, type, assignment.property);
            changes.push({
                path: assignment.property,
                value:
                    value === null && target && resolveType(ir, target).kind === "optional"
                        ? undefined
                        : value,
            });
        }
        if (step.kind === "updateObject") yield* tx.patch(type.name, key!, changes);
        else {
            let value: Record<string, unknown> = {};
            for (const change of changes) value = setAtPath(value, change.path, change.value);
            if (value[type.primaryKey] === undefined) {
                const pk = type.properties.find((p) => p.name === type!.primaryKey);
                if (!pk || unwrapValueType(ir, pk.type).kind !== "string") continue;
                value[type.primaryKey] = `optimistic:${request.id}:${type.name}:${index}`;
            }
            const key = yield* keyOf(value[type.primaryKey]);
            if (yield* tx.get(type.name, key)) return yield* failure("Object already exists.", "Conflict");
            yield* tx.put(type.name, value);
        }
    }
    const mutator = options.mutators?.[request.name];
    const result = mutator
        ? yield* mutator(
              {
                  get: (type, key) => tx.get(type, key),
                  loadSubset: (type, scan) => tx.loadSubset(type, scan),
                  put: (type, value) => tx.put(type, value),
                  patch: (type, key, changes) => tx.patch(type, key, changes),
                  delete: (type, key) => tx.delete(type, key),
                  query: (document, settings) =>
                      executeQuery(document, {
                          reader: { ir, loadSubset: (type, scan) => tx.loadSubset(type, scan) },
                          context: options.context,
                          inputs: settings?.inputs,
                      }).pipe(Effect.map((result) => result.value)),
              },
              { ...request, parameters },
              options.context ?? {}
          )
        : undefined;
    return { parameters, result };
}, Effect.catchDefect(defect));

/** Resolve defaults against an authorized transaction-consistent native reader. */
export const resolveReadActionParameters = Effect.fn("Action.resolveParameters")(function* (options: {
    readonly ir: OntologyIR;
    readonly read: OwnedReadTransaction;
    readonly context?: Record<string, unknown>;
    readonly name: string;
    readonly parameters: Record<string, unknown>;
}) {
    return yield* actionExpressions({
        ir: options.ir,
        tx: options.read,
        request: { id: "resolve", name: options.name, parameters: options.parameters },
        context: options.context,
    }).resolve;
});
