import { BackendError } from "@party-stack/ontology-backend";
import { policyProperties } from "@party-stack/ontology-backend/policy";
import { queryExecutor } from "@party-stack/ontology-backend/query";
import { validate } from "@party-stack/ontology-spec";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import { projectRemoteOntologyIR } from "./securedOntology.js";
import type { FixedActionParameterValues } from "./securedOntology.js";
import type { QueryReader } from "@party-stack/ontology-backend/query";
import type { Expression, OntologyIR, QuerySelection } from "@party-stack/ontology-spec";

/** Only immutable context/literal computations may specialize the public contract.
 * Database-dependent checks continue to run for each request/transaction.
 */
function contextOnly(value: unknown): boolean {
    if (!value || typeof value !== "object") return true;
    if ("kind" in value) {
        if (value.kind === "literal") return true;
        if (
            ["inputReference", "localReference", "exists", "objectLookup", "related", "now", "uuid"].includes(
                String(value.kind)
            )
        )
            return false;
    }
    return Object.values(value).every((v) => (Array.isArray(v) ? v.every(contextOnly) : contextOnly(v)));
}

export const validateContext = Effect.fnUntraced(function* (
    ir: OntologyIR,
    context: Record<string, unknown>,
    type = ir.context?.type
) {
    const codec = Table.make<Record<string, unknown>>({ name: "bound-ontology-context" });
    const snapshot = yield* Effect.try({
        try: () => codec.decode(codec.encode(context)),
        catch: () =>
            new BackendError({
                operation: "context",
                kind: "InvalidConfiguration",
                message: "Ontology context must contain portable values.",
                retryable: false,
            }),
    });
    if (!type) {
        if (Object.keys(snapshot).length)
            return yield* new BackendError({
                operation: "context",
                kind: "InvalidConfiguration",
                message: "Declare the ontology context type before binding context values.",
                retryable: false,
            });
        return snapshot;
    }
    let name = "ContextBinding";
    while ([...ir.types, ...ir.objectTypes].some((t) => t.name === name)) name += "_";
    const schemas = yield* Effect.try({
        try: () => compileEffectSchemas({ ...ir, types: [...ir.types, { name, type }] }),
        catch: () =>
            new BackendError({
                operation: "context",
                kind: "InvalidConfiguration",
                message: "Invalid context definition.",
                retryable: false,
            }),
    });
    yield* Schema.decodeUnknownEffect(Schema.toEncoded(schemas.namedSchemas[name]!), {
        onExcessProperty: "error",
    })(snapshot).pipe(
        Effect.mapError(
            () =>
                new BackendError({
                    operation: "context",
                    kind: "InvalidConfiguration",
                    message: "The bound context does not match its definition.",
                    retryable: false,
                })
        )
    );
    return snapshot;
});

export const projectPolicyDefinition = Effect.fnUntraced(function* (options: {
    ir: OntologyIR;
    reader: QueryReader;
    context: Record<string, unknown>;
}) {
    const { ir, context } = options;
    const evaluator = queryExecutor({ reader: options.reader, context, knownInputs: new Set() });
    const condition = Effect.fnUntraced(function* (expression: Expression) {
        if (!contextOnly(expression)) return undefined;
        const value = yield* evaluator.evaluate(expression);
        if (!value.certain) return undefined;
        if (typeof value.value !== "boolean")
            return yield* new BackendError({
                operation: "policy",
                kind: "InvalidConfiguration",
                message: "A policy condition must return a boolean.",
                retryable: false,
            });
        return value.value;
    });
    const specialize = Effect.fnUntraced(function* (
        items: readonly QuerySelection[]
    ): Effect.fn.Return<QuerySelection[], BackendError> {
        const selected: QuerySelection[] = [];
        for (const item of items) {
            if (item.kind === "sub") {
                selected.push({
                    ...item,
                    value: {
                        ...item.value,
                        query: { ...item.value.query, select: yield* specialize(item.value.query.select) },
                    },
                });
            } else if (item.kind === "field") selected.push(item);
            else {
                const branches = [];
                let fallback = item.value.else ?? [];
                for (const branch of item.value.branches) {
                    const test = yield* condition(branch.condition);
                    if (test === false) continue;
                    if (test === true) {
                        fallback = branch.select;
                        break;
                    }
                    branches.push({ ...branch, select: yield* specialize(branch.select) });
                }
                const otherwise = yield* specialize(fallback);
                if (branches.length) selected.push({ ...item, value: { branches, else: otherwise } });
                else selected.push(...otherwise);
            }
        }
        return selected;
    });
    const policy = ir.policy!;
    const read = { ...policy.read, select: yield* specialize(policy.read.select) };
    const actions = [];
    for (const rule of policy.actions ?? []) if ((yield* condition(rule.check)) !== false) actions.push(rule);
    const queries = [];
    for (const rule of policy.queryFunctions ?? [])
        if ((yield* condition(rule.check)) !== false) queries.push(rule);
    const specialized: OntologyIR = { ...ir, policy: { ...policy, read, actions, queryFunctions: queries } };
    const properties = policyProperties(specialized);
    const fixed: FixedActionParameterValues = Object.fromEntries(
        actions.map((a) => [
            a.actionType,
            Object.fromEntries((a.bind ?? []).map((b) => [b.parameter, b.expression])),
        ])
    );
    const exposed = yield* validateContext(ir, context);
    const visible = projectRemoteOntologyIR({
        ir: { ...ir, policy: undefined },
        serverContext: context,
        clientContext: exposed,
        clientContextMode: "forward",
        allowedObjectTypeProperties: Object.fromEntries(
            [...properties.allowed].map(([type, names]) => [type, [...names]])
        ),
        fixedActionParameterValues: fixed,
        projectFixedActionParameterValuesInDefaults: true,
        filterSchemaByAuthorization: true,
        visibleActionTypes: actions.map((a) => a.actionType),
        visibleQueryFunctionTypes: queries.map((q) => q.queryFunctionType),
    });
    visible.objectTypes = visible.objectTypes.map((object) => ({
        ...object,
        properties: object.properties.map((property) =>
            properties.guaranteed.get(object.name)?.has(property.name) || property.type.kind === "optional"
                ? property
                : { ...property, type: { kind: "optional", value: { type: property.type } } }
        ),
    }));
    // Replacing the context can invalidate an upstream prediction. Validate
    // both before and after projection: stripping an assignment must not turn
    // an invalid source program into an apparently valid partial prediction.
    const invalidPredictions = new Map<string, (readonly (string | number)[])[]>();
    for (const candidate of [{ ...ir, policy: undefined }, visible]) {
        const validation = validate(candidate);
        if (validation.kind === "err") {
            for (const issue of validation.value) {
                const path = issue.path;
                if (path?.[0] === "actionTypes" && typeof path[1] === "number" && path[2] === "logic") {
                    const name = candidate.actionTypes[path[1]]!.name;
                    invalidPredictions.set(name, [...(invalidPredictions.get(name) ?? []), path]);
                }
            }
        }
    }
    visible.actionTypes = visible.actionTypes.map((action) =>
        invalidPredictions.has(action.name) ? { ...action, logic: [] } : action
    );
    for (const action of visible.actionTypes) {
        const source = ir.actionTypes.find((candidate) => candidate.name === action.name)!;
        const omittedDefaults = action.parameters
            .filter(
                (parameter) =>
                    !parameter.defaultValue &&
                    source.parameters.find((candidate) => candidate.name === parameter.name)?.defaultValue
            )
            .map((parameter) => ["parameters", parameter.name, "defaultValue"]);
        const paths = [...(invalidPredictions.get(action.name) ?? []), ...omittedDefaults];
        if (paths.length)
            yield* Effect.logWarning(
                "Omitted client action computations incompatible with the projected ontology.",
                { action: action.name, paths }
            );
    }
    const validation = validate(visible);
    if (validation.kind === "err")
        return yield* new BackendError({
            operation: "policy.project",
            kind: "InvalidConfiguration",
            message: "The projected ontology definition is invalid.",
            issues: validation.value,
            retryable: false,
        });
    return { ir: visible, context: exposed, specialized, fixed };
});
