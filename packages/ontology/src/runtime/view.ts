import { BackendError } from "@party-stack/ontology-backend";
import { makeReplicaMonitor } from "@party-stack/ontology-replica";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { Runtime } from "@party-stack/runtime";
import { DbClient } from "@tanstack/db";
import { Schema } from "effect";
import { Effect, Scope, Fiber, Stream, Cause } from "effect";
import { createLiveOntologyAction } from "../live/actions/createLiveOntologyAction.js";
import { makeOntologyPins } from "../live/pins.js";
import { ontologyCollections, ontologyCollectionDependency } from "../tanstack/descriptors.js";
import {
    replicatedCollectionOptions,
    persistedCollectionOptions,
    scopedCollection,
} from "../tanstack/index.js";
import type { OntologyApplyActionResult } from "../live/actions/types.js";
import type { LiveOntologyAttachments } from "../live/attachments/createLiveOntologyAttachments.js";
import type { LiveOntology, LiveOntologyWrites } from "../live/LiveOntology.js";
import type { OntologyOutbox, OntologyOutboxEntry, OntologyActionRequest } from "../live/outbox/types.js";
import type { ActionRequest, ActionReceipt } from "@party-stack/ontology-backend";
import type { PendingAction, ReplicaService, ReplicaPinControls } from "@party-stack/ontology-replica";
import type { OntologyIR, OntologyObject } from "@party-stack/ontology-spec";
import type { TraceStore } from "@party-stack/runtime/tracing";
import type { Collection } from "@tanstack/db";
const toEntry = (entry: PendingAction, forwarding = false): OntologyOutboxEntry => ({
    id: entry.invocation.id,
    sequence: entry.sequence,
    request: {
        actionTypeName: entry.invocation.name,
        parameters: entry.invocation.parameters,
        idempotencyKey: entry.invocation.id,
        replay: entry.invocation.replay,
    },
    visibility: entry.optimistic ? "optimistic" : "confirmed",
    status: entry.state,
    createdAt: entry.createdAt,
    attempts: entry.attempts,
    attemptStage: forwarding ? "forwarding" : "execution",
    retryable: entry.failureRetryable ?? true,
    retryRequiresAcknowledgement: entry.retryRequiresAcknowledgement,
    nextAttemptAt: entry.nextAttemptAt ?? 0,
    lastError: entry.failure
        ? new BackendError({
              operation: "applyAction",
              kind: entry.failure,
              message:
                  entry.failureMessage ?? "Action is blocked; resolve its cause and retry or discard it.",
              retryable: entry.failureRetryable ?? false,
              actionOutcome: entry.failureOutcome,
              issues: entry.failureIssues,
          })
        : undefined,
});
const actionResult = (receipt: ActionReceipt): OntologyApplyActionResult => ({
    receipt,
    attachmentIdMappings: receipt.attachmentIdMappings ? [...receipt.attachmentIdMappings] : undefined,
});

export interface ReplicaViewOptions {
    readonly ir: OntologyIR;
    readonly context: Record<string, unknown>;
    readonly writes?: LiveOntologyWrites;
    readonly replica: ReplicaService;
    readonly attachments: LiveOntologyAttachments;
    readonly pins?: ReplicaPinControls;
    readonly pinBackend?: Effect.Effect<
        import("@party-stack/ontology-backend").OntologyBackendService,
        BackendError,
        Scope.Scope
    >;
    readonly traces?: TraceStore;
    readonly parentDiagnostics?: LiveOntology["diagnostics"];
    readonly diagnosticLabel?: string;
}

/** Materialize a scoped UI view over an existing replica; engine ownership is independent. */
export const makeReplicaOntologyView = Effect.fn("Ontology.view")(function* (
    options: ReplicaViewOptions
): Effect.fn.Return<Omit<LiveOntology, "cleanup">, BackendError, Runtime | Scope.Scope> {
    const services = yield* Runtime;
    const runtime = services;
    const { ir, context, replica } = options;
    const schemas = compileEffectSchemas(ir);
    const actionReturns = schemas.actionReturnSchemas;
    const visiblePending = replica.outbox.entries;
    const replicaMonitor = yield* makeReplicaMonitor(replica.status.changes);
    const outboxEntries = Effect.map(visiblePending, (entries) =>
        entries.map((entry) => toEntry(entry, entry.forwarding))
    );
    const owner = yield* Effect.scope;
    const captured = yield* Effect.context<Runtime>();
    const dbClient = yield* Effect.acquireRelease(
        Effect.sync(
            () =>
                new DbClient({
                    [ontologyCollectionDependency]: (id: string, objectType: string, localOnly: boolean) => {
                        if (owner.state._tag === "Closed")
                            throw new BackendError({
                                operation: "ontology.collection",
                                kind: "InvalidRequest",
                                retryable: false,
                                message: "Ontology view is closed.",
                            });
                        const object = ir.objectTypes.find((object) => object.name === objectType);
                        if (!object)
                            throw new BackendError({
                                operation: "ontology.collection",
                                kind: "InvalidRequest",
                                retryable: false,
                                message: `Unknown object type: ${objectType}.`,
                            });
                        return Effect.runSyncWith(captured)(
                            Scope.provide(
                                replicatedCollectionOptions({
                                    id,
                                    replica,
                                    objectType,
                                    localOnly,
                                    getKey: (row: OntologyObject) =>
                                        row[object.primaryKey] as string | number,
                                }),
                                owner
                            )
                        );
                    },
                })
        ),
        (client) => Effect.promise(() => client.cleanup())
    );
    const pendingCollection = yield* scopedCollection(
        yield* persistedCollectionOptions<OntologyOutboxEntry, string>({
            id: `${runtime.namespace}:outbox`,
            getKey: (entry) => entry.id,
            changes: Stream.empty,
            observe: () =>
                replica.outbox.observe().pipe(
                    Stream.map((entries) => ({
                        reset: true,
                        rows: entries.map((entry) => ({
                            key: entry.invocation.id,
                            value: toEntry(entry, entry.forwarding),
                        })),
                        removed: [],
                    }))
                ),
            load: Effect.map(outboxEntries, (entries) =>
                entries.map((entry) => ({ key: entry.id, value: entry }))
            ),
        }),
        dbClient
    );
    const run = <A, E>(work: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal) =>
        Effect.runPromiseWith(captured)(
            Effect.suspend(() =>
                owner.state._tag === "Closed"
                    ? Effect.interrupt
                    : Effect.flatMap(
                          Effect.forkIn(Scope.provide(work, owner), owner, { startImmediately: true }),
                          (fiber) => Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
                      )
            ),
            { signal }
        );
    const wait = (id: string, until: "accepted" | "confirmed" = "confirmed") =>
        replica.outbox
            .wait(id, { until })
            .pipe(Effect.map((receipt) => (receipt ? actionResult(receipt) : undefined)));
    const descriptors = ontologyCollections(
        Object.fromEntries(ir.objectTypes.map((type) => [type.name, type.primaryKey]))
    );
    const objectCollections = (localOnly: boolean) => {
        const collections: Record<string, Collection<OntologyObject>> = {};
        for (const object of ir.objectTypes) {
            let collection: Collection<OntologyObject> | undefined;
            Object.defineProperty(collections, object.name, {
                enumerable: true,
                get: () => {
                    if (collection) return collection;
                    if (owner.state._tag === "Closed")
                        throw new BackendError({
                            operation: "ontology.collection",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "Ontology view is closed.",
                        });
                    // Descriptors and SDK getters share the same client-owned instance.
                    collection = dbClient.collection(
                        (localOnly ? descriptors.cachedObjects : descriptors.objects)[object.name]!
                    );
                    return collection;
                },
            });
        }
        return collections;
    };
    const objects = objectCollections(false);
    const cachedObjects = objectCollections(true);
    const enqueue = async (
        request: Omit<OntologyActionRequest, "idempotencyKey"> & { idempotencyKey?: string },
        visibility?: "confirmed" | "optimistic"
    ) => {
        const invocation: ActionRequest = {
            id: request.idempotencyKey ?? crypto.randomUUID(),
            name: request.actionTypeName,
            parameters: request.parameters,
            replay: request.replay,
        };
        const entry = await run(
            replica.outbox.enqueue(invocation, {
                optimistic: (visibility ?? options.writes?.defaultVisibility) === "optimistic",
            })
        );
        const accepted = run(wait(entry.invocation.id, "accepted")).then(() => undefined);
        void accepted.catch(() => undefined);
        const completed = run(wait(entry.invocation.id)).then((result) => {
            if (!result)
                throw new BackendError({
                    operation: "applyAction",
                    kind: "ResultExpired",
                    message: "Action result is unavailable.",
                    retryable: false,
                    actionOutcome: "unknown",
                });
            return result;
        });
        void completed.catch(() => undefined);
        if (replica.upstreamKind === "speculative") await accepted;
        return { entry: toEntry(entry, replica.upstreamKind === "speculative"), accepted, completed };
    };
    const outbox: OntologyOutbox = {
        collection: pendingCollection,
        enqueue: async <A>(
            request: Omit<OntologyActionRequest, "idempotencyKey"> & { idempotencyKey?: string },
            settings?: { visibility?: "confirmed" | "optimistic" }
        ) => {
            const result = await enqueue(request, settings?.visibility);
            return { ...result, completed: result.completed as Promise<A> };
        },
        remove: (id, settings) => run(replica.outbox.remove(id, settings)),
        retry: (id, settings) => run(replica.outbox.retry(id, settings)),
        wait: <A>(id: string, settings?: { until?: "accepted" | "confirmed"; signal?: AbortSignal }) =>
            run(wait(id, settings?.until), settings?.signal) as Promise<A | void>,
        edit: async (id, update) => {
            const entry = (await run(visiblePending)).find((entry) => entry.invocation.id === id);
            if (!entry)
                throw new BackendError({
                    operation: "outbox.edit",
                    kind: "NotFound",
                    retryable: false,
                    message: "Outbox entry is unavailable.",
                });
            const request = toEntry(entry).request;
            update(request);
            const invocation = {
                id,
                name: request.actionTypeName,
                parameters: request.parameters,
                replay: request.replay,
            };
            await run(replica.outbox.edit(id, invocation));
        },
    };
    const actions = Object.fromEntries(
        ir.actionTypes.map((action) => [
            action.name,
            createLiveOntologyAction({
                action,
                resolveParameters: (name, parameters) =>
                    run(replica.actions.resolveParameters(name, parameters)),
                submit: async (request, settings) => {
                    const visibility =
                        settings?.visibility ?? options.writes?.defaultVisibility ?? "confirmed";
                    const receipt = await run(
                        replica.actions.apply(
                            {
                                id: request.idempotencyKey ?? crypto.randomUUID(),
                                name: request.actionTypeName,
                                parameters: request.parameters,
                                replay: request.replay,
                            },
                            { optimistic: visibility === "optimistic" }
                        )
                    );
                    const schema = actionReturns[action.name];
                    const result = schema
                        ? await run(
                              Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(receipt.result).pipe(
                                  Effect.mapError(
                                      (cause) =>
                                          new BackendError({
                                              operation: "applyAction.result",
                                              kind: "InvalidResponse",
                                              retryable: false,
                                              message:
                                                  "Committed action result does not match its definition.",
                                              cause,
                                          })
                                  )
                              )
                          )
                        : undefined;
                    return { ...actionResult(receipt), result };
                },
                validate: (name, parameters) => run(replica.actions.validate(name, parameters)),
                validateDraft: (name, parameters, settings) =>
                    run(
                        replica.actions.validate(name, parameters, {
                            knownParameters: settings?.knownParameters ?? [],
                        })
                    ),
            }),
        ])
    );
    const downloadPins = yield* makeOntologyPins({
        backend: options.pinBackend ?? replica.demand.pins.backend,
        dbClient,
    });
    const clearFamily = downloadPins.clear;
    return {
        dbClient,
        ir,
        context,
        objects,
        cachedObjects,
        actions,
        outbox,
        pins: Object.assign(downloadPins, {
            get: () => run((options.pins ?? replica.demand).pinStatus),
            set: (
                query: import("@party-stack/ontology-spec").QueryDocument,
                settings?: import("@party-stack/ontology-replica").PinOptions
            ) => run((options.pins ?? replica.demand).setPin(query, settings)),
            clear: (name?: string) =>
                name === undefined ? run((options.pins ?? replica.demand).clearPin) : clearFamily(name),
            subscribe: (
                listener: (status: import("@party-stack/ontology-replica").PinStatus | undefined) => void,
                onError?: (error: unknown) => void
            ) => {
                if (owner.state._tag === "Closed")
                    throw new BackendError({
                        operation: "pins.subscribe",
                        kind: "InvalidRequest",
                        retryable: false,
                        message: "Ontology view is closed.",
                    });
                const watch = Stream.runForEach((options.pins ?? replica.demand).pinStatusChanges, (status) =>
                    Effect.sync(() => listener(status))
                ).pipe(
                    Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                            ? Effect.void
                            : Effect.sync(() => {
                                  if (onError) onError(Cause.squash(cause));
                                  else console.error("Pin subscription failed.", Cause.pretty(cause));
                              })
                    )
                );
                const fiber = Effect.runSyncWith(captured)(Effect.forkIn(watch, owner));
                return () => {
                    Effect.runFork(Fiber.interrupt(fiber));
                };
            },
        }),
        attachments: options.attachments,
        decrypt: async (value, settings) =>
            (await run(replica.decrypt(value, settings), settings?.signal)).value as never,
        queryFunctions: Object.fromEntries(
            ir.queryFunctionTypes.map((query) => [
                query.name,
                (parameters: Record<string, unknown>) => run(replica.queryFunction(query.name, parameters)),
            ])
        ),
        traces: options.traces,
        diagnostics: {
            label: options.diagnosticLabel,
            role: replica.upstreamKind === "committed" ? "host" : "replica",
            location: "In process",
            replica: replicaMonitor,
            traces: options.traces,
            parent: options.parentDiagnostics,
        },
        replica,
    };
});
