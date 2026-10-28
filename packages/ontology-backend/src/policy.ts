import { Context, Effect } from "effect";
import { denied, evaluatePolicyView } from "./policy/view.js";
import { queryExecutor } from "./query.js";
import { BackendError } from "./index.js";
import type { ActionRequest } from "./index.js";
import type { OwnedReadTransaction } from "./owned.js";
import type { PolicyViewOptions } from "./policy/view.js";
import type { QueryReader } from "./query.js";
import type { Expression } from "@party-stack/ontology-spec";
import type { Uncertain } from "@party-stack/ontology-spec/utils";
import type { Schema } from "effect";

export interface ActionAuthorization {
    /** Stable authenticated partition, not a caller-supplied idempotency namespace. */
    readonly scope: string;
    /** Public input contracts exclude server-bound parameters. */
    readonly parameterSchemas: Readonly<Record<string, Schema.Codec<Record<string, unknown>>>>;
    readonly apply: (
        tx: OwnedReadTransaction,
        action: ActionRequest
    ) => Effect.Effect<
        {
            readonly parameters: Record<string, unknown>;
            readonly read: OwnedReadTransaction;
        },
        BackendError
    >;
}
/** Trusted invocation context for native application implementations. */
export const CurrentExecutionContext = Context.Reference<Record<string, unknown> | undefined>(
    "@party-stack/ontology-backend/CurrentExecutionContext",
    { defaultValue: () => undefined }
);
/** Trusted server composition only; never accepted through RPC data. */
export const CurrentActionAuthorization = Context.Reference<ActionAuthorization | undefined>(
    "@party-stack/ontology-backend/CurrentActionAuthorization",
    { defaultValue: () => undefined }
);
export const CurrentQueryAuthorization = Context.Reference<
    | ((
          tx: OwnedReadTransaction,
          name: string,
          parameters: Record<string, unknown>
      ) => Effect.Effect<OwnedReadTransaction, BackendError>)
    | undefined
>("@party-stack/ontology-backend/CurrentQueryAuthorization", { defaultValue: () => undefined });
export { policyProperties } from "./policy/view.js";
export { policyIndexes } from "./policy/indexes.js";
export { actionReferenceIssues } from "./references.js";
export type { PolicyViewOptions } from "./policy/view.js";

/** One production path; the eager evaluator is retained privately for oracle tests. */
export function policyView(
    reader: QueryReader,
    context: Record<string, unknown>,
    options?: PolicyViewOptions
) {
    return evaluatePolicyView(reader, context, options);
}

function parameterDependencies(expression: Expression): Set<string> {
    if (expression.kind === "literal") return new Set();
    const result = new Set<string>();
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if ("kind" in value && value.kind === "literal") return;
        if ("kind" in value && value.kind === "inputReference" && "value" in value) {
            result.add((value.value as { name: string }).name);
            return;
        }
        Object.values(value).forEach((v) => (Array.isArray(v) ? v.forEach(visit) : visit(v)));
    };
    visit(expression);
    return result;
}
export const authorizeAction = Effect.fn("Policy.authorizeAction")(function* (
    reader: QueryReader,
    context: Record<string, unknown>,
    name: string,
    supplied: Record<string, unknown>,
    known?: ReadonlySet<string>
) {
    const rule = reader.ir.policy?.actions?.find((a) => a.actionType === name);
    const action = reader.ir.actionTypes.find((a) => a.name === name);
    if (!rule || !action) return yield* denied("applyAction");
    const parameters = { ...supplied },
        knownInputs = new Set(known ?? action.parameters.map((p) => p.name));
    const bindings = new Map(rule.bind?.map((b) => [b.parameter, b.expression]));
    const done = new Set<string>(),
        visiting = new Set<string>();
    const evaluator = queryExecutor({
        reader,
        context,
        inputs: parameters,
        inputDefinitions: action.parameters,
        knownInputs,
    });
    const bind = Effect.fnUntraced(function* (parameter: string): Effect.fn.Return<void, BackendError> {
        if (done.has(parameter)) return;
        if (visiting.has(parameter))
            return yield* new BackendError({
                operation: "policy.bind",
                kind: "InvalidConfiguration",
                message: "Cyclic action parameter bindings.",
                retryable: false,
            });
        visiting.add(parameter);
        const expr = bindings.get(parameter)!;
        for (const dependency of parameterDependencies(expr))
            if (bindings.has(dependency)) yield* bind(dependency);
        const value = yield* evaluator.evaluate(expr);
        if (value.certain) {
            parameters[parameter] = value.value;
            knownInputs.add(parameter);
        } else {
            delete parameters[parameter];
            knownInputs.delete(parameter);
        }
        visiting.delete(parameter);
        done.add(parameter);
    });
    for (const parameter of bindings.keys()) yield* bind(parameter);
    const check = yield* evaluator.evaluate(rule.check);
    if (check.certain && typeof check.value !== "boolean")
        return yield* new BackendError({
            operation: "policy.check",
            kind: "InvalidConfiguration",
            message: "Policy check must return a boolean.",
            retryable: false,
        });
    return {
        parameters,
        knownInputs,
        check: check as Uncertain<boolean>,
        read: policyView(reader, context, {
            extraRead: rule.read,
            inputs: parameters,
            inputDefinitions: action.parameters,
        }).tx,
    };
});
