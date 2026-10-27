import { resolveReadActionParameters } from "@party-stack/ontology";
import { BackendError, projectBackendError } from "@party-stack/ontology-backend";
import { and, eq, field } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { errorContext, projectValidationReport } from "./errorProjection.js";
import { applyFixedActionParameterValues, projectRemoteOntologyIR } from "./securedOntology.js";
import type { FixedActionParameterValues } from "./securedOntology.js";
import type { OntologyIR } from "@party-stack/ontology";
import type { ErrorProjection, ObjectChange, OntologyBackendService } from "@party-stack/ontology-backend";
import type { Query } from "@party-stack/ontology-storage";

export interface BackendProjectionPolicy<Context> {
    readonly allowedObjectTypeProperties: Readonly<Record<string, readonly string[]>>;
    /** Portable row predicates compose before source pagination. */
    readonly baseObjectTypeQueries?: Readonly<Record<string, Query["where"]>>;
    readonly visibleActionTypes?: readonly string[] | "all";
    readonly visibleQueryFunctionTypes?: readonly string[] | "all";
    readonly fixedActionParameterValues?: FixedActionParameterValues;
    readonly clientContext?: "forward" | ((context: Context) => Record<string, unknown>);
    readonly errors?: ErrorProjection;
    readonly canApplyAction?: (
        name: string,
        parameters: Record<string, unknown>
    ) => Effect.Effect<boolean, BackendError>;
    readonly canRunQueryFunction?: (
        name: string,
        parameters: Record<string, unknown>
    ) => Effect.Effect<boolean, BackendError>;
}

/** Bind after authenticating the caller. This projects ordinary operations, not
 * privileged replica state/outbox inspection. Never share this binding across principals.
 */
export function projectOntologyBackend<Context>(options: {
    readonly backend: OntologyBackendService;
    readonly ir: OntologyIR;
    readonly context: Context;
    readonly policy: BackendProjectionPolicy<Context>;
}) {
    const { backend, policy } = options;
    const context =
        policy.clientContext === "forward"
            ? (options.context as Record<string, unknown>)
            : policy.clientContext?.(options.context);
    const schemaPolicy = {
        ir: options.ir,
        serverContext: options.context,
        clientContext: context,
        clientContextMode:
            policy.clientContext === "forward" ? "forward" : policy.clientContext ? "projected" : "none",
        allowedObjectTypeProperties: { ...policy.allowedObjectTypeProperties },
        filterSchemaByAuthorization: true,
        fixedActionParameterValues: policy.fixedActionParameterValues,
        visibleActionTypes: policy.visibleActionTypes,
        visibleQueryFunctionTypes: policy.visibleQueryFunctionTypes,
    } as const;
    const ir = projectRemoteOntologyIR(schemaPolicy);
    const resolutionIr = projectRemoteOntologyIR({
        ...schemaPolicy,
        projectFixedActionParameterValuesInDefaults: true,
    });
    const projection = { ir, errors: policy.errors, upstreamErrors: true };
    const denied = (operation: string) =>
        new BackendError({
            operation,
            kind: "NotFound",
            message: "Resource not found.",
            retryable: false,
            invocationOutcome: "not-committed",
        });
    const expose = <A, E extends BackendError>(name: string, work: Effect.Effect<A, E>) =>
        work.pipe(
            Effect.mapError((error) =>
                projectBackendError(error, policy.errors, errorContext(projection, name))
            )
        );
    const parameters = (name: string, values: Record<string, unknown>) =>
        applyFixedActionParameterValues({
            ctx: options.context,
            actionType: name,
            parameters: values,
            fixedActionParameterValues: policy.fixedActionParameterValues,
        });
    const projected: OntologyBackendService = {
        name: backend.name,
        sourceId: backend.sourceId,
        supportsIdempotency: backend.supportsIdempotency,
        resolveActionParameters: (name, values) =>
            expose(
                name,
                Effect.gen(function* () {
                    const action = resolutionIr.actionTypes.find((action) => action.name === name);
                    if (!action) return yield* denied("resolveActionParameters");
                    const result = yield* resolveReadActionParameters({
                        ir: resolutionIr,
                        context: context ?? {},
                        name,
                        parameters: parameters(name, values),
                        read: {
                            get: (objectType, key) =>
                                Effect.gen(function* () {
                                    const definition = resolutionIr.objectTypes.find(
                                        (type) => type.name === objectType
                                    );
                                    if (!definition) return yield* denied("resolveActionParameters");
                                    const snapshot = yield* projected.loadSubset({
                                        objectType,
                                        query: { where: eq(field(definition.primaryKey), key), limit: 1 },
                                    });
                                    return snapshot.rows[0]?.value;
                                }),
                            loadSubset: (objectType, query) =>
                                projected
                                    .loadSubset({ objectType, query })
                                    .pipe(Effect.map((snapshot) => snapshot.rows)),
                        },
                    });
                    const visible = new Set(action.parameters.map((parameter) => parameter.name));
                    return Object.fromEntries(Object.entries(result).filter(([key]) => visible.has(key)));
                })
            ),
        // Row predicates need before/after visibility tracking for deletes and moves.
        // Until query watching supplies it, those projections use subset snapshots.
        changes:
            backend.changes && !Object.values(policy.baseObjectTypeQueries ?? {}).some(Boolean)
                ? {
                      watch: backend.changes.watch,
                      pull: (request) =>
                          expose(
                              "pullChanges",
                              backend.changes!.pull(request).pipe(
                                  Effect.map((page) => ({
                                      ...page,
                                      commits: page.commits.flatMap((commit) => {
                                          const changes = commit.changes.flatMap((change): ObjectChange[] => {
                                              const definition = ir.objectTypes.find(
                                                  (type) => type.name === change.objectType
                                              );
                                              if (!definition) return [];
                                              if (change.kind === "delete") return [change];
                                              const allowed = new Set(
                                                  definition.properties.map((property) => property.name)
                                              );
                                              return [
                                                  {
                                                      ...change,
                                                      value: Object.fromEntries(
                                                          Object.entries(change.value).filter(([key]) =>
                                                              allowed.has(key)
                                                          )
                                                      ),
                                                  },
                                              ];
                                          });
                                          return changes.length ? [{ cursor: commit.cursor, changes }] : [];
                                      }),
                                  }))
                              )
                          ),
                  }
                : undefined,
        loadSubset: (subset) =>
            expose(
                "loadSubset",
                Effect.gen(function* () {
                    const definition = ir.objectTypes.find((type) => type.name === subset.objectType);
                    if (!definition) return yield* denied("loadSubset");
                    const allowed = new Set(definition.properties.map((property) => property.name));
                    // Hidden fields cannot be queried as an existence/value oracle.
                    const fieldsAllowed = (value: unknown): boolean => {
                        if (value === null || typeof value !== "object") return true;
                        const node = value as { _tag?: string; path?: readonly string[] };
                        if (node._tag === "Field")
                            return Boolean(node.path?.[0] && allowed.has(node.path[0]));
                        return Object.values(value).every(fieldsAllowed);
                    };
                    if (!fieldsAllowed(subset.query)) return yield* denied("loadSubset");
                    const base = policy.baseObjectTypeQueries?.[subset.objectType];
                    const response = yield* backend.loadSubset({
                        ...subset,
                        query: {
                            ...subset.query,
                            where:
                                base && subset.query?.where
                                    ? and(base, subset.query.where)
                                    : (base ?? subset.query?.where),
                        },
                    });
                    return {
                        ...response,
                        pushdown: undefined,
                        rows: response.rows.map((row) => ({
                            ...row,
                            value: Object.fromEntries(
                                Object.entries(row.value).filter(([key]) => allowed.has(key))
                            ),
                        })),
                    };
                })
            ),
        invoke: (invocation) =>
            expose(
                invocation.name,
                Effect.gen(function* () {
                    if (!ir.actionTypes.some((action) => action.name === invocation.name))
                        return yield* denied("invoke");
                    const values = parameters(invocation.name, invocation.parameters);
                    if (policy.canApplyAction && !(yield* policy.canApplyAction(invocation.name, values)))
                        return yield* denied("invoke");
                    const receipt = yield* backend.invoke({ ...invocation, parameters: values });
                    // Do not reveal upstream cursor positions, hidden affected types or row IDs.
                    return {
                        invocationId: receipt.invocationId,
                        outcome: receipt.outcome,
                        attachmentIdMappings: receipt.attachmentIdMappings,
                        affected: receipt.affected
                            ?.filter((target) =>
                                ir.objectTypes.some((type) => type.name === target.objectType)
                            )
                            .map((target) => ({ objectType: target.objectType })),
                        affectedComplete: receipt.affectedComplete,
                    };
                })
            ),
        validateAction:
            backend.validateAction &&
            ((name, values, settings) =>
                expose(
                    name,
                    Effect.gen(function* () {
                        if (!ir.actionTypes.some((action) => action.name === name))
                            return yield* denied("validateAction");
                        const fixed = parameters(name, values);
                        if (policy.canApplyAction && !(yield* policy.canApplyAction(name, fixed)))
                            return yield* denied("validateAction");
                        const report = yield* backend.validateAction!(
                            name,
                            fixed,
                            settings?.knownParameters
                                ? {
                                      ...settings,
                                      knownParameters: [
                                          ...new Set([
                                              ...settings.knownParameters,
                                              ...Object.keys(policy.fixedActionParameterValues?.[name] ?? {}),
                                          ]),
                                      ],
                                  }
                                : settings
                        );
                        return projectValidationReport(report, projection, name);
                    })
                )),
        queryFunction: (name, values) =>
            expose(
                name,
                Effect.gen(function* () {
                    if (!ir.queryFunctionTypes.some((query) => query.name === name))
                        return yield* denied("queryFunction");
                    if (!policy.canRunQueryFunction || !(yield* policy.canRunQueryFunction(name, values)))
                        return yield* denied("queryFunction");
                    return yield* backend.queryFunction(name, values);
                })
            ),
    };
    return { backend: projected, ir, context };
}
