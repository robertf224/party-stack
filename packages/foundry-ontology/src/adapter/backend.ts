import { makeObjectSetWatcher } from "@party-stack/foundry-object-set-watcher";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { QuerySchema } from "@party-stack/ontology-storage";
import { isField } from "@party-stack/ontology-storage/tables";
import { Deferred, Effect, Queue, Schema, Stream, Redacted } from "effect";
import { searchFoundryObjects } from "./foundryObjectSearch.js";
import { analyzeSubsetFilter, subsetFilter } from "./subsetFilter.js";
import type { Actions } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { ObjectSetSubscriptionMessage, WatcherError } from "@party-stack/foundry-object-set-watcher";
import type {
    OntologyBackendService,
    ActionRequest,
    ActionReceipt,
    SourceQueryPlan,
    SubsetWatchEvent,
} from "@party-stack/ontology-backend";
import type { BackendSnapshot } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Query } from "@party-stack/ontology-storage";

const KeySchema = Schema.Union([Schema.String, Schema.Finite]);
const ObjectTarget = Schema.Struct({ objectType: Schema.String, primaryKey: Schema.Unknown });
const ActionResult = Schema.Struct({
    operationId: Schema.optional(Schema.String),
    edits: Schema.optional(
        Schema.Union([
            Schema.Struct({
                type: Schema.Literal("largeScaleEdits"),
                editedObjectTypes: Schema.Array(Schema.String),
            }),
            Schema.Struct({
                type: Schema.Literal("edits"),
                edits: Schema.Array(
                    Schema.Union([
                        Schema.Struct({
                            type: Schema.Literals(["addObject", "modifyObject", "deleteObject"]),
                            ...ObjectTarget.fields,
                        }),
                        Schema.Struct({
                            type: Schema.Literals(["addLink", "deleteLink"]),
                            aSideObject: ObjectTarget,
                            bSideObject: ObjectTarget,
                        }),
                    ])
                ),
            }),
        ])
    ),
});
const invalidResponse = (operation: string, cause: unknown) =>
    new BackendError({
        operation,
        kind: "InvalidResponse",
        message: "Foundry returned an invalid response.",
        retryable: false,
        actionOutcome: "unknown",
        cause: Redacted.make(cause),
    });
const unavailable = (cause: unknown) => classifyBackendFailure("foundry.sync", cause);

/** Each logical object set has its own acknowledgement. Pump before returning so
 * changes between that acknowledgement and the snapshot read remain observable.
 */
const acquireWatch = Effect.fn("Foundry.acquireWatch")(function* (
    messages: Stream.Stream<ObjectSetSubscriptionMessage, WatcherError>
) {
    const ready = yield* Deferred.make<void, BackendError>();
    const events = yield* Effect.acquireRelease(Queue.sliding<SubsetWatchEvent, BackendError>(1), (queue) =>
        Queue.shutdown(queue).pipe(Effect.asVoid)
    );
    const interrupted = () =>
        new BackendError({
            operation: "foundry.watchSubset",
            kind: "Unavailable",
            retryable: true,
            message: "The Foundry object-set subscription is no longer active.",
        });
    const receive = Stream.runForEach(messages, (message) => {
        if (message.type !== "state") return Queue.offer(events, undefined).pipe(Effect.asVoid);
        return message.status === "open"
            ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
            : Effect.fail(interrupted());
    }).pipe(
        Effect.mapError(unavailable),
        Effect.andThen(Effect.fail(interrupted())),
        Effect.catchCause((cause) =>
            Deferred.failCause(ready, cause).pipe(
                Effect.andThen(Queue.failCause(events, cause)),
                Effect.asVoid
            )
        )
    );
    yield* Effect.forkScoped(receive, { startImmediately: true });
    yield* Deferred.await(ready);
    return Stream.fromQueue(events);
});

/** One scoped watcher multiplexes the live object types used by this binding.
 * Watch messages invalidate snapshots; they do not pretend to be durable journal cursors.
 */
export const makeFoundryBackend = Effect.fn("FoundryBackend.make")(function* (options: {
    client: OntologyClient;
    ir: OntologyIR;
    context: Record<string, unknown>;
    watch?: boolean;
    users?: {
        objectType: string;
        loadSubset: (query: Query, signal: AbortSignal) => Promise<BackendSnapshot>;
    };
    submitAction: (
        invocation: ActionRequest,
        signal: AbortSignal
    ) => Promise<{
        result: Awaited<ReturnType<typeof Actions.applyWithOverrides>> & { operationId?: string };
        attachmentIdMappings: readonly { localId: string; remoteId: string }[];
    }>;
    queryFunction?: (
        name: string,
        parameters: Record<string, unknown>,
        signal: AbortSignal
    ) => Promise<unknown>;
    attachments?: OntologyBackendService["attachments"];
    encrypted?: OntologyBackendService["encrypted"];
    decodeObject: (objectType: string, value: Record<string, unknown>) => Record<string, unknown>;
}) {
    const watcher =
        options.watch === false
            ? undefined
            : yield* makeObjectSetWatcher(options.client).pipe(Effect.mapError(unavailable));
    return makeOntologyBackend({
        ir: options.ir,
        context: options.context,
        name: "foundry",
        sourceId: `foundry:${options.client.baseUrl}:${options.client.ontologyRid}`,
        supportsIdempotency: false,
        queryFunction: (name: string, parameters: Record<string, unknown>) =>
            options.queryFunction
                ? Effect.tryPromise({
                      try: (signal) => options.queryFunction!(name, parameters, signal),
                      catch: unavailable,
                  })
                : Effect.fail(
                      new BackendError({
                          operation: "queryFunction",
                          kind: "NotImplemented",
                          message: "No Foundry query function implementation.",
                          retryable: false,
                      })
                  ),
        attachments: options.attachments,
        encrypted: options.encrypted,
        loadSubset: Effect.fn("Foundry.loadSubset")(function* (request: ObjectSubset) {
            const subset = yield* compileObjectSubset(options.ir, request, options.context);
            yield* Effect.annotateCurrentSpan("objectType", subset.objectType);
            yield* Schema.decodeUnknownEffect(QuerySchema)(subset.query ?? {}).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "foundry.loadSubset",
                            kind: "InvalidRequest",
                            message: "Invalid subset query.",
                            retryable: false,
                            cause: Redacted.make(cause),
                        })
                )
            );
            if (subset.objectType === options.users?.objectType)
                return yield* Effect.tryPromise({
                    try: (signal) => options.users!.loadSubset(subset.query ?? {}, signal),
                    catch: unavailable,
                });
            const definition = options.ir.objectTypes.find((type) => type.name === subset.objectType);
            if (!definition)
                return yield* new BackendError({
                    operation: "foundry.loadSubset",
                    kind: "InvalidRequest",
                    message: "Unknown Foundry object type.",
                    retryable: false,
                });
            const predicate = subset.query?.where;
            const candidates =
                predicate?.op === "in" &&
                isField(predicate.left) &&
                predicate.left.path.length === 1 &&
                predicate.left.path[0] === definition.primaryKey
                    ? predicate.values
                    : predicate?.op === "eq" &&
                        isField(predicate.left) &&
                        predicate.left.path.length === 1 &&
                        predicate.left.path[0] === definition.primaryKey &&
                        !isField(predicate.right)
                      ? [predicate.right]
                      : undefined;
            const keys = candidates?.every(Schema.is(KeySchema))
                ? (candidates as readonly (string | number)[])
                : undefined;
            const plan = analyzeSubsetFilter(predicate);
            const pushed = keys
                ? { type: "in" as const, field: definition.primaryKey, value: [...new Set(keys)] }
                : plan.query;
            const values = yield* Effect.tryPromise({
                try: (signal) =>
                    searchFoundryObjects(
                        options.client,
                        subset.objectType,
                        definition.properties.map((property) => property.name),
                        {
                            signal,
                            where: pushed,
                        },
                        (value) => options.decodeObject(subset.objectType, value)
                    ),
                catch: unavailable,
            });
            const rows = yield* Effect.forEach(values, (value) =>
                Schema.decodeUnknownEffect(KeySchema)(value[definition.primaryKey]).pipe(
                    Effect.map((key) => ({ key, value })),
                    Effect.mapError((cause) => invalidResponse("foundry.loadSubset", cause))
                )
            );
            return {
                fulfilledSubset: objectSubset(subset.objectType, { where: subset.query?.where }),
                fetchedRows: values.length,
                pushdown: {
                    source: "Foundry",
                    predicates: plan.predicates.map((predicate) => ({
                        ...predicate,
                        execution:
                            predicate.execution === "adapter" ? ("engine" as const) : predicate.execution,
                    })),
                    sorting: subset.query?.orderBy?.length ? "engine" : "none",
                    pagination:
                        subset.query?.limit !== undefined ||
                        subset.query?.offset !== undefined ||
                        subset.query?.after
                            ? "engine"
                            : "none",
                    rechecksFilter: Boolean(predicate),
                    native: {
                        language: "json",
                        text: JSON.stringify(pushed ?? { type: "and", value: [] }, null, 2),
                    },
                } satisfies SourceQueryPlan,
                rows,
                complete: true,
            };
        }),
        applyAction: Effect.fn("Foundry.applyAction")(function* (invocation: ActionRequest) {
            const { result: rawResult, attachmentIdMappings } = yield* Effect.tryPromise({
                try: (signal) => options.submitAction(invocation, signal),
                catch: (cause) => classifyBackendFailure("foundry.applyAction", cause),
            });
            const result = yield* Schema.decodeUnknownEffect(ActionResult)(rawResult).pipe(
                Effect.mapError((cause) => invalidResponse("foundry.applyAction", cause))
            );
            return yield* Effect.try({
                try: () => {
                    const targets = new Map<string, Set<string | number> | undefined>();
                    const add = (objectType: string, rawKey?: unknown) => {
                        const definition = options.ir.objectTypes.find((type) => type.name === objectType);
                        if (!definition || objectType === options.users?.objectType) return;
                        const key =
                            rawKey === undefined
                                ? undefined
                                : options.decodeObject(objectType, { [definition.primaryKey]: rawKey })[
                                      definition.primaryKey
                                  ];
                        if (rawKey === undefined) targets.set(objectType, undefined);
                        else if (!Schema.is(KeySchema)(key)) throw new Error("Invalid edit identity.");
                        else if (!targets.has(objectType) || targets.get(objectType))
                            targets.set(objectType, new Set([...(targets.get(objectType) ?? []), key]));
                    };
                    if (!result.edits) for (const type of options.ir.objectTypes) add(type.name);
                    else if (result.edits.type === "largeScaleEdits")
                        for (const type of result.edits.editedObjectTypes) add(type);
                    else
                        for (const edit of result.edits.edits) {
                            if ("aSideObject" in edit) {
                                add(edit.aSideObject.objectType, edit.aSideObject.primaryKey);
                                add(edit.bSideObject.objectType, edit.bSideObject.primaryKey);
                            } else add(edit.objectType, edit.primaryKey);
                        }
                    return {
                        operationId: invocation.id,
                        outcome: "committed",
                        providerOperationId: result.operationId,
                        affected: [...targets].map(([objectType, keys]) => ({
                            objectType,
                            ...(keys ? { keys: [...keys] } : {}),
                        })),
                        attachmentIdMappings: attachmentIdMappings.length ? attachmentIdMappings : undefined,
                    } satisfies ActionReceipt;
                },
                catch: (cause) => invalidResponse("foundry.applyAction", cause),
            });
        }),
        // Admin users have no ontology websocket feed; the Replica owns this polling lifetime.
        refresh: (subset: ObjectSubset) =>
            subset.from.source.objectType === options.users?.objectType
                ? { pollIntervalMs: 60_000 }
                : undefined,
        watchSubset: watcher
            ? (request: ObjectSubset) =>
                  request.from.source.objectType === options.users?.objectType
                      ? undefined
                      : Effect.gen(function* () {
                            const subset = yield* compileObjectSubset(options.ir, request, options.context);
                            const filter = subsetFilter(subset.query?.where);
                            return yield* acquireWatch(
                                watcher.subscribe(
                                    filter
                                        ? {
                                              type: "filter",
                                              objectSet: { type: "base", objectType: subset.objectType },
                                              where: filter,
                                          }
                                        : { type: "base", objectType: subset.objectType }
                                )
                            );
                        })
            : undefined,
    });
});
