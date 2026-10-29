import { resolveReadActionParameters } from "@party-stack/ontology";
import { BackendError, projectBackendError, schemaValidationIssues } from "@party-stack/ontology-backend";
import {
    authorizeAction,
    CurrentActionAuthorization,
    CurrentQueryAuthorization,
    CurrentExecutionContext,
    policyView,
    policyIndexes,
    actionReferenceIssues,
} from "@party-stack/ontology-backend/policy";
import { queryExecutor, executeQuery } from "@party-stack/ontology-backend/query";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { validatePolicy } from "@party-stack/ontology-spec/query";
import { contextPartition, resolveType } from "@party-stack/ontology-spec/utils";
import { collectAttachments } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema, Stream } from "effect";
import { projectOntologyDefinition } from "./definitionProjection.js";
import { errorContext, projectValidationReport } from "./errorProjection.js";
import { projectPolicyDefinition, validateContext } from "./policyDefinition.js";
import type {
    ActionRequest,
    ErrorProjection,
    OntologyBackendService,
    ValidationReport,
} from "@party-stack/ontology-backend";
import type { OwnedReadTransaction, OwnedStorageService } from "@party-stack/ontology-backend/owned";
import type { QueryReader } from "@party-stack/ontology-backend/query";
import type { OntologyIR, QueryDocument } from "@party-stack/ontology-spec";

export interface OntologyProjectionOptions {
    readonly backend: OntologyBackendService;
    readonly ir: OntologyIR;
    readonly context: Record<string, unknown>;
    readonly errors?: ErrorProjection;
}
const unavailable = (operation: string) =>
    new BackendError({
        operation,
        kind: "NotFound",
        message: "Resource not found.",
        retryable: false,
        actionOutcome: "not-committed",
    });
const permitted = (check: { certain: boolean; value?: unknown }) => check.certain && check.value === true;

/** IR is the only domain permission contract. Never inherit privileged journals,
 * selected delivery or speculative state through a row-filtered binding.
 */
export const projectOntologyBackend = Effect.fn("Ontology.projectBackend")(function* (
    input: OntologyProjectionOptions,
    execution: "owned" | "upstream" = "upstream"
) {
    const codec = Table.make<OntologyIR>({ name: "bound-ontology-definition" });
    const sourceIr = yield* Effect.try({
        try: () => codec.decode(codec.encode(input.ir)),
        catch: () =>
            new BackendError({
                operation: "policy",
                kind: "InvalidConfiguration",
                message: "Invalid portable ontology definition.",
                retryable: false,
            }),
    });
    const options = { ...input, ir: sourceIr };
    const { backend } = options;
    const issues = validatePolicy(options.ir);
    if (!options.ir.policy || issues.length)
        return yield* new BackendError({
            operation: "policy",
            kind: "InvalidConfiguration",
            message: "A valid ontology policy is required for a projected view.",
            issues,
            retryable: false,
        });
    const context = yield* validateContext(options.ir, options.context);
    const storage = "storage" in backend ? (backend.storage as OwnedStorageService) : undefined;
    const sourceReader: QueryReader = {
        ir: options.ir,
        loadSubset: (objectType, query) =>
            backend.loadSubset({ objectType, query }).pipe(
                Effect.flatMap((snapshot) =>
                    snapshot.complete
                        ? Effect.succeed(snapshot.rows)
                        : Effect.fail(
                              new BackendError({
                                  operation: "policy.read",
                                  kind: "InvalidResponse",
                                  message: "Policy evaluation requires a complete subset snapshot.",
                                  retryable: false,
                              })
                          )
                )
            ),
    };
    const definition = yield* projectPolicyDefinition({ ...options, context, reader: sourceReader });
    const ir = definition.ir;
    const boundIr = definition.specialized;
    if (storage)
        yield* storage.transaction((tx) =>
            Effect.forEach(
                policyIndexes(boundIr),
                ({ objectType, index }) => tx.ensureIndex(objectType, index),
                { discard: true }
            )
        );

    const reader = { ...sourceReader, ir: boundIr };
    const withRead = <A>(
        work: (reader: QueryReader) => Effect.Effect<A, BackendError>
    ): Effect.Effect<A, BackendError> =>
        storage
            ? storage.read((tx) =>
                  work({ ir: boundIr, loadSubset: (type, query) => tx.loadSubset(type, query) })
              )
            : work(reader);
    const schemas = yield* Effect.try({
        try: () => compileEffectSchemas(options.ir),
        catch: () =>
            new BackendError({
                operation: "policy",
                kind: "InvalidConfiguration",
                message: "Invalid policy source schemas.",
                retryable: false,
            }),
    });
    const publicSchemas = yield* Effect.try({
        try: () => compileEffectSchemas(ir),
        catch: () =>
            new BackendError({
                operation: "policy",
                kind: "InvalidConfiguration",
                message: "Invalid projected schemas.",
                retryable: false,
            }),
    });
    const projection = { ir, errors: options.errors, upstreamErrors: true };
    const expose = <A>(name: string, work: Effect.Effect<A, BackendError>) =>
        work.pipe(
            Effect.mapError((error) =>
                projectBackendError(
                    error.kind === "Forbidden" ? unavailable(name) : error,
                    options.errors,
                    errorContext(projection, name)
                )
            )
        );
    const authorized = Effect.fnUntraced(function* (
        source: QueryReader,
        name: string,
        parameters: Record<string, unknown>,
        known?: ReadonlySet<string>
    ) {
        if (!ir.actionTypes.some((a) => a.name === name)) return yield* unavailable("applyAction");
        return yield* authorizeAction(source, context, name, parameters, known);
    });
    const actionHook = Effect.fnUntraced(function* (tx: OwnedReadTransaction, request: ActionRequest) {
        const result = yield* authorized(
            { ir: boundIr, loadSubset: (type, query) => tx.loadSubset(type, query) },
            request.name,
            request.parameters
        );
        if (!permitted(result.check)) return yield* unavailable("applyAction");
        return { parameters: result.parameters, read: result.read };
    });
    const functionRead = Effect.fnUntraced(function* (
        source: QueryReader,
        name: string,
        parameters: Record<string, unknown>
    ) {
        const rule = boundIr.policy?.queryFunctions?.find((q) => q.queryFunctionType === name);
        const query = boundIr.queryFunctionTypes.find((q) => q.name === name);
        if (!rule || !query || !ir.queryFunctionTypes.some((q) => q.name === name))
            return yield* unavailable("queryFunction");
        const check = yield* queryExecutor({
            reader: source,
            context,
            inputs: parameters,
            inputDefinitions: query.parameters,
        }).evaluate(rule.check);
        if (!permitted(check)) return yield* unavailable("queryFunction");
        return policyView(source, context, {
            extraRead: rule.read,
            inputs: parameters,
            inputDefinitions: query.parameters,
        }).tx;
    });
    const projected: OntologyBackendService = {
        name: backend.name,
        sourceId: backend.sourceId,
        supportsIdempotency: backend.supportsIdempotency,
        loadSubset: (subset) =>
            expose(
                "loadSubset",
                withRead((source) =>
                    policyView(source, context)
                        .tx.loadSubset(subset.objectType, subset.query)
                        .pipe(Effect.map((rows) => ({ rows, complete: true })))
                )
            ),
        applyAction: (request) =>
            expose(
                request.name,
                Effect.gen(function* () {
                    if (!ir.actionTypes.some((a) => a.name === request.name))
                        return yield* unavailable("applyAction");
                    const parameters = storage
                        ? request.parameters
                        : yield* withRead(
                              Effect.fnUntraced(function* (source) {
                                  const result = yield* authorized(source, request.name, request.parameters);
                                  const parsed = yield* Schema.decodeUnknownEffect(
                                      Schema.toEncoded(schemas.actionParameterSchemas[request.name]!)
                                  )(result.parameters).pipe(
                                      Effect.mapError(
                                          (error) =>
                                              new BackendError({
                                                  operation: "applyAction",
                                                  kind: "ValidationFailed",
                                                  message: "Action parameters do not match their definition.",
                                                  issues: schemaValidationIssues(error),
                                                  retryable: false,
                                                  actionOutcome: "not-committed",
                                              })
                                      )
                                  );
                                  const issues = yield* actionReferenceIssues(
                                      boundIr,
                                      boundIr.actionTypes.find((a) => a.name === request.name)!.parameters,
                                      parsed,
                                      result.read
                                  );
                                  if (issues.length)
                                      return yield* new BackendError({
                                          operation: "applyAction",
                                          kind: "ValidationFailed",
                                          message: "Submission failed validation.",
                                          issues,
                                          retryable: false,
                                          actionOutcome: "not-committed",
                                      });
                                  if (!permitted(result.check)) return yield* unavailable("applyAction");
                                  return parsed;
                              })
                          );
                    const receipt = yield* backend.applyAction({ ...request, parameters }).pipe(
                        Effect.provideService(CurrentActionAuthorization, {
                            scope: partition,
                            parameterSchemas: publicSchemas.actionParameterSchemas,
                            apply: actionHook,
                        }),
                        Effect.provideService(
                            CurrentExecutionContext,
                            execution === "owned" ? context : undefined
                        )
                    );
                    return {
                        operationId: receipt.operationId,
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
        validateAction: (name, values, settings) =>
            expose(
                name,
                withRead(
                    Effect.fnUntraced(function* (source): Effect.fn.Return<ValidationReport, BackendError> {
                        const result = yield* authorized(
                            source,
                            name,
                            values,
                            settings?.knownParameters ? new Set(settings.knownParameters) : undefined
                        );
                        const action = boundIr.actionTypes.find((a) => a.name === name)!;
                        const fields = settings?.knownParameters
                            ? action.parameters.filter((p) => result.knownInputs.has(p.name))
                            : action.parameters;
                        const schema =
                            fields === action.parameters
                                ? schemas.actionParameterSchemas[name]!
                                : compileEffectSchemas({
                                      ...boundIr,
                                      actionTypes: [{ ...action, parameters: fields }],
                                  }).actionParameterSchemas[name]!;
                        const parsed = yield* Effect.result(
                            Schema.decodeUnknownEffect(Schema.toEncoded(schema))(result.parameters)
                        );
                        if (parsed._tag === "Failure")
                            return projectValidationReport(
                                {
                                    certain: true,
                                    value: { kind: "err", value: schemaValidationIssues(parsed.failure) },
                                },
                                projection,
                                name
                            );
                        const refs = yield* actionReferenceIssues(
                            boundIr,
                            fields,
                            parsed.success,
                            result.read
                        );
                        if (refs.length)
                            return projectValidationReport(
                                { certain: true, value: { kind: "err", value: refs } },
                                projection,
                                name
                            );
                        if (result.check.certain && !result.check.value)
                            return yield* unavailable("validateAction");
                        if (!result.check.certain) return { certain: false };
                        const report =
                            !storage && backend.validateAction
                                ? yield* backend.validateAction(
                                      name,
                                      result.parameters,
                                      settings?.knownParameters
                                          ? { knownParameters: [...result.knownInputs] }
                                          : undefined
                                  )
                                : { certain: false as const };
                        return projectValidationReport(report, projection, name);
                    })
                )
            ),
        resolveActionParameters: (name, values) =>
            expose(
                name,
                withRead(
                    Effect.fnUntraced(function* (source) {
                        const result = yield* authorized(source, name, values, new Set(Object.keys(values)));
                        const resolutionIr = projectOntologyDefinition({
                            ir: { ...options.ir, policy: undefined },

                            context: definition.context,

                            allowedObjectTypeProperties: Object.fromEntries(
                                ir.objectTypes.map((t) => [t.name, t.properties.map((p) => p.name)])
                            ),
                            visibleActionTypes: ir.actionTypes.map((a) => a.name),
                            visibleQueryFunctionTypes: [],
                            fixedActionParameterValues: definition.fixed,
                            projectFixedActionParameterValuesInDefaults: true,
                            filterSchemaByAuthorization: true,
                        });
                        const resolved = yield* resolveReadActionParameters({
                            ir: resolutionIr,
                            name,
                            context: definition.context,
                            parameters: result.parameters,
                            read: policyView(source, context).tx,
                        });
                        const visible = new Set(
                            ir.actionTypes.find((a) => a.name === name)!.parameters.map((p) => p.name)
                        );
                        return Object.fromEntries(
                            Object.entries(resolved).filter(([key]) => visible.has(key))
                        );
                    })
                )
            ),
        queryFunction: (name, parameters) =>
            expose(
                name,
                Effect.gen(function* () {
                    if (!storage) yield* withRead((source) => functionRead(source, name, parameters));
                    return yield* backend.queryFunction(name, parameters).pipe(
                        Effect.provideService(CurrentQueryAuthorization, (tx, name, parameters) =>
                            functionRead(
                                { ir: boundIr, loadSubset: (type, query) => tx.loadSubset(type, query) },
                                name,
                                parameters
                            )
                        ),
                        Effect.provideService(
                            CurrentExecutionContext,
                            execution === "owned" ? context : undefined
                        )
                    );
                })
            ),
        watchSubset:
            backend.watchSubset || backend.changes?.watch
                ? (subset) =>
                      Stream.unwrap(
                          Effect.gen(function* () {
                              yield* projected.loadSubset(subset);
                              return backend.watchSubset?.(subset) ?? backend.changes?.watch ?? Stream.empty;
                          })
                      )
                : undefined,
        pollIntervalMs: (subset) => backend.pollIntervalMs?.(subset),
    };
    const sourceRow = Effect.fnUntraced(function* (
        source: { objectType: string; primaryKey: string | number; property: string } | undefined
    ) {
        const object = ir.objectTypes.find((t) => t.name === source?.objectType);
        const property = object?.properties.find((p) => p.name === source?.property);
        if (!source || !object || !property) return yield* unavailable("property.read");
        const value = yield* withRead((reader) =>
            policyView(reader, context).tx.get(object.name, source.primaryKey)
        );
        if (!value || !Object.hasOwn(value, property.name)) return yield* unavailable("property.read");
        return { value: value[property.name], property };
    });
    const attachments = backend.attachments && {
        read: (
            value: Parameters<NonNullable<OntologyBackendService["attachments"]>["read"]>[0],
            settings?: Parameters<NonNullable<OntologyBackendService["attachments"]>["read"]>[1]
        ) =>
            expose(
                "attachment.read",
                Effect.gen(function* () {
                    const row = yield* sourceRow(value.source);
                    if (
                        !collectAttachments(ir, row.property.type, row.value).some(
                            (entry) => entry.attachment.id === value.id
                        )
                    )
                        return yield* unavailable("attachment.read");
                    return yield* backend.attachments!.read(value, settings);
                })
            ),
        metadata: (
            value: Parameters<NonNullable<OntologyBackendService["attachments"]>["metadata"]>[0],
            settings?: Parameters<NonNullable<OntologyBackendService["attachments"]>["metadata"]>[1]
        ) =>
            expose(
                "attachment.metadata",
                Effect.gen(function* () {
                    const row = yield* sourceRow(value.source);
                    if (
                        !collectAttachments(ir, row.property.type, row.value).some(
                            (entry) => entry.attachment.id === value.id
                        )
                    )
                        return yield* unavailable("attachment.metadata");
                    return yield* backend.attachments!.metadata(value, settings);
                })
            ),
    };
    const encrypted = backend.encrypted && {
        decrypt: (value: Parameters<NonNullable<OntologyBackendService["encrypted"]>["decrypt"]>[0]) =>
            expose(
                "decrypt",
                Effect.gen(function* () {
                    const row = yield* sourceRow(value.source);
                    let type = resolveType(ir, row.property.type);
                    while (type.kind === "optional") type = resolveType(ir, type.value.type);
                    if (
                        type.kind !== "encrypted" ||
                        !row.value ||
                        typeof row.value !== "object" ||
                        !("ciphertext" in row.value) ||
                        row.value.ciphertext !== value.ciphertext
                    )
                        return yield* unavailable("decrypt");
                    return yield* backend.encrypted!.decrypt(value);
                })
            ),
    };
    const partition = yield* Effect.try({
        try: () => contextPartition(options.ir, context),
        catch: () =>
            new BackendError({
                operation: "context.partition",
                kind: "InvalidConfiguration",
                message: "Invalid context partition binding.",
                retryable: false,
            }),
    });
    const visibleBackend: OntologyBackendService = { ...projected, attachments, encrypted };
    return {
        backend: visibleBackend,
        ir,
        context: definition.context,
        // The caller authenticated this principal before constructing the view.
        // This gate only keeps private/admin protocol methods off that endpoint.
        authorize: (request: import("./rpc.js").OntologyRpcRequest) =>
            [
                "Describe",
                "Query",
                "LoadSubset",
                "WatchSubset",
                "ApplyAction",
                "ValidateAction",
                "ResolveActionParameters",
                "QueryFunction",
                "ReadAttachment",
                "AttachmentMetadata",
                "Decrypt",
            ].includes(request.operation)
                ? Effect.void
                : Effect.fail(unavailable(request.operation)),
        query: (document: QueryDocument, inputs?: Record<string, unknown>) =>
            expose(
                "query",
                withRead((source) => {
                    const view = policyView(source, context);
                    return executeQuery(document, {
                        reader: { ...view.reader, ir },
                        context: definition.context,
                        inputs,
                        canReadProperty: view.canReadProperty,
                    }).pipe(Effect.map((result) => result.value));
                })
            ),
    };
});
