import { makeObjectSetWatcher } from "@party-stack/foundry-object-set-watcher";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { isField } from "@party-stack/ontology-storage/tables";
import { Effect, Schema, Stream } from "effect";
import { searchFoundryObjects } from "./foundryObjectSearch.js";
import { analyzeSubsetFilter, subsetFilter } from "./subsetFilter.js";
import type { Actions } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type {
    OntologyBackendService,
    ActionInvocation,
    ActionReceipt,
    BackendSubset,
    SourceQueryPlan,
} from "@party-stack/ontology-backend";
import type { BackendSnapshot } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Query } from "@party-stack/ontology-storage";

const KeySchema = Schema.Union([Schema.String, Schema.Finite]);
const unavailable = (cause: unknown) => classifyBackendFailure("foundry.sync", cause);

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
        invocation: ActionInvocation,
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
    return {
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
        loadSubset: Effect.fn("Foundry.loadSubset")(function* (subset: BackendSubset) {
            yield* Effect.annotateCurrentSpan("objectType", subset.objectType);
            if (subset.objectType === options.users?.objectType)
                return yield* Effect.tryPromise({
                    try: (signal) => options.users!.loadSubset(subset.query ?? {}, signal),
                    catch: unavailable,
                });
            const definition = options.ir.objectTypes.find((type) => type.name === subset.objectType);
            if (!definition)
                return yield* new BackendError({
                    operation: "foundry.loadSubset",
                    kind: "ValidationFailed",
                    message: "Unknown Foundry object type.",
                    retryable: false,
                });
            yield* Effect.try({ try: () => evaluateQuery([], subset.query ?? {}), catch: unavailable });
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
            return {
                fetchedRows: values.length,
                pushdown: {
                    source: "Foundry",
                    predicates: plan.predicates,
                    sorting: subset.query?.orderBy?.length ? "adapter" : "none",
                    pagination:
                        subset.query?.limit !== undefined ||
                        subset.query?.offset !== undefined ||
                        subset.query?.after
                            ? "adapter"
                            : "none",
                    rechecksFilter: Boolean(predicate),
                    native: {
                        language: "json",
                        text: JSON.stringify(pushed ?? { type: "and", value: [] }, null, 2),
                    },
                } satisfies SourceQueryPlan,
                rows: evaluateQuery(
                    values.map((value) => ({ key: value[definition.primaryKey] as string | number, value })),
                    subset.query ?? {}
                ),
                complete: true,
            };
        }),
        invoke: Effect.fn("Foundry.invoke")(function* (invocation: ActionInvocation) {
            const { result, attachmentIdMappings } = yield* Effect.tryPromise({
                try: (signal) => options.submitAction(invocation, signal),
                catch: (cause) =>
                    cause instanceof BackendError
                        ? cause
                        : cause instanceof Error && cause.name === "NonRetryableError"
                          ? new BackendError({
                                operation: "foundry.invoke",
                                kind: "ValidationFailed",
                                message: cause.message,
                                retryable: false,
                                cause,
                            })
                          : unavailable(cause),
            });
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
                if (!Schema.is(KeySchema)(key)) targets.set(objectType, undefined);
                else if (!targets.has(objectType) || targets.get(objectType))
                    targets.set(objectType, new Set([...(targets.get(objectType) ?? []), key]));
            };
            if (!result.edits) for (const type of options.ir.objectTypes) add(type.name);
            else if (result.edits.type === "largeScaleEdits")
                for (const type of result.edits.editedObjectTypes) add(type);
            else
                for (const edit of result.edits.edits) {
                    if (edit.type === "addLink" || edit.type === "deleteLink") {
                        add(edit.aSideObject.objectType, edit.aSideObject.primaryKey);
                        add(edit.bSideObject.objectType, edit.bSideObject.primaryKey);
                    } else add(edit.objectType, edit.primaryKey);
                }
            return {
                invocationId: invocation.id,
                outcome: "committed",
                operationId: result.operationId,
                affected: [...targets].map(([objectType, keys]) => ({
                    objectType,
                    ...(keys ? { keys: [...keys] } : {}),
                })),
                attachmentIdMappings: attachmentIdMappings.length ? attachmentIdMappings : undefined,
            } satisfies ActionReceipt;
        }),
        // Admin users have no ontology websocket feed; the Replica owns this polling lifetime.
        pollIntervalMs: (subset: BackendSubset) =>
            subset.objectType === options.users?.objectType ? 60_000 : undefined,
        watchSubset: watcher
            ? (subset: BackendSubset) =>
                  subset.objectType === options.users?.objectType
                      ? undefined
                      : watcher
                            .subscribe(
                                subsetFilter(subset.query?.where)
                                    ? {
                                          type: "filter",
                                          objectSet: { type: "base", objectType: subset.objectType },
                                          where: subsetFilter(subset.query?.where)!,
                                      }
                                    : { type: "base", objectType: subset.objectType }
                            )
                            .pipe(
                                Stream.mapEffect((message) =>
                                    message.type === "state" &&
                                    (message.status === "qos" || message.status === "error")
                                        ? Effect.fail(unavailable(message.status))
                                        : Effect.void
                                ),
                                Stream.mapError(unavailable)
                            )
            : undefined,
    };
});
