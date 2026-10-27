import { BackendError, encryptedPropertyCodec } from "@party-stack/ontology-backend";
import { makeReplicaMonitor } from "@party-stack/ontology-replica";
import { Runtime } from "@party-stack/runtime";
import { DbClient } from "@tanstack/db";
import { Effect, Scope, Fiber } from "effect";
import { createLiveOntologyAction } from "../live/actions/createLiveOntologyAction.js";
import { decorateObjectAttachmentSources } from "../live/attachments/attachmentSources.js";
import { decorateObjectEncryptedSources } from "../live/encryptedSources.js";
import { makeReplicatedCollection, persistedCollectionOptions, scopedCollection } from "../tanstack/index.js";
import { makeLiveDecryption } from "./encrypted.js";
import type { LiveOntologyAttachments } from "../live/attachments/createLiveOntologyAttachments.js";
import type { LiveOntology, LiveOntologyWrites } from "../live/LiveOntology.js";
import type { OntologyApplyActionResult } from "../live/OntologyBackendAdapter.js";
import type { OntologyOutbox, OntologyOutboxEntry, OntologyActionRequest } from "../live/outbox/types.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { ActionRequest, ActionReceipt } from "@party-stack/ontology-backend";
import type { PendingAction, ReplicaService } from "@party-stack/ontology-replica";
import type { OntologyIR, OntologyObject } from "@party-stack/ontology-spec";
import type { RuntimeTraceStore } from "@party-stack/runtime";
import type { Collection } from "@tanstack/db";
const toEntry = (entry: PendingAction, forwarding = false): OntologyOutboxEntry => ({
    id: entry.invocation.id,
    sequence: entry.sequence,
    request: {
        actionTypeName: entry.invocation.name,
        parameters: entry.invocation.parameters,
        idempotencyKey: entry.invocation.id,
    },
    visibility: entry.optimistic ? "optimistic" : "confirmed",
    status: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
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
    readonly queryFunction: OntologyBackendService["queryFunction"];
    readonly resolveActionParameters?: OntologyBackendService["resolveActionParameters"];
    readonly encrypted?: OntologyBackendService["encrypted"];
    readonly sourceId?: string;
    /** A memory tab forwards cache policy to its persistent owner. */
    readonly decrypt?: (
        value: import("@party-stack/ontology-spec/values").Encrypted,
        options?: { cache?: boolean }
    ) => Effect.Effect<unknown, BackendError>;
    readonly traces?: RuntimeTraceStore;
    readonly parentDiagnostics?: LiveOntology["diagnostics"];
    readonly diagnosticLabel?: string;
    /** Memory children resolve enqueue only after their durable owner accepts the action. */
    readonly awaitParentAcceptance?: boolean;
    readonly parentOutbox?: Pick<ReplicaService, "remove" | "retry" | "edit" | "reconcile">;
    readonly validate?: (
        name: string,
        parameters: Record<string, unknown>,
        objects: LiveOntology["objects"]
    ) => Effect.Effect<import("@party-stack/ontology-backend").ValidationReport, BackendError>;
    readonly validateDraft?: (
        name: string,
        parameters: Record<string, unknown>,
        knownParameters: readonly string[],
        objects: LiveOntology["objects"]
    ) => Effect.Effect<import("@party-stack/ontology-backend").ValidationReport, BackendError>;
}

/** Materialize a scoped UI view over an existing replica; engine ownership is independent. */
export const makeReplicaOntologyView = Effect.fn("Ontology.view")(function* (
    options: ReplicaViewOptions
): Effect.fn.Return<Omit<LiveOntology, "cleanup" | "destroy">, BackendError, Runtime | Scope.Scope> {
    const services = yield* Runtime;
    const runtime = services.adapter;
    const { ir, context, replica } = options;
    const visiblePending = replica.pendingActions;
    const replicaMonitor = yield* makeReplicaMonitor(replica.statuses);
    const outboxEntries = Effect.map(visiblePending, (entries) =>
        entries.map((entry) => toEntry(entry, entry.forwarding))
    );
    const control = (id: string) =>
        Effect.map(replica.pending, (pending) =>
            pending.some((entry) => entry.invocation.id === id) ? replica : (options.parentOutbox ?? replica)
        );
    const command = (
        id: string,
        work: (
            target: Pick<ReplicaService, "remove" | "retry" | "edit" | "reconcile">
        ) => Effect.Effect<void, BackendError>
    ) =>
        control(id).pipe(
            Effect.flatMap((target) =>
                work(target).pipe(Effect.andThen(target === replica ? Effect.void : replica.syncOnce))
            )
        );
    const dbClient = yield* Effect.acquireRelease(
        Effect.sync(() => new DbClient()),
        (client) => Effect.promise(() => client.cleanup())
    );
    const objects: Record<string, Collection<OntologyObject>> = {};
    const persistedObjects: Record<string, Collection<OntologyObject>> = {};
    for (const object of ir.objectTypes) {
        const opts = {
            replica,
            objectType: object.name,
            map: (row: OntologyObject) =>
                decorateObjectEncryptedSources(
                    ir,
                    object,
                    decorateObjectAttachmentSources({ ir, objectType: object, object: row })
                ),
            getKey: (row: OntologyObject) => row[object.primaryKey] as string | number,
        };
        objects[object.name] = yield* makeReplicatedCollection(
            {
                ...opts,
                id: `${runtime.owner}:${runtime.namespace}:objects:${object.name}`,
            },
            dbClient
        );
        persistedObjects[object.name] = yield* makeReplicatedCollection(
            {
                ...opts,
                id: `${runtime.owner}:${runtime.namespace}:persisted:${object.name}`,
                persistedOnly: true,
            },
            dbClient
        );
    }
    const pendingCollection = yield* scopedCollection(
        yield* persistedCollectionOptions<OntologyOutboxEntry, string>({
            id: `${runtime.namespace}:outbox`,
            getKey: (entry) => entry.id,
            changes: yield* replica.subscribeChanges,
            acquireDemand: replica.retainActions(),
            load: Effect.map(outboxEntries, (entries) =>
                entries.map((entry) => ({ key: entry.id, value: entry }))
            ),
        }),
        dbClient
    );
    const owner = yield* Effect.scope;
    const captured = yield* Effect.context<Runtime>();
    const run = <A, E>(work: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal) =>
        Effect.runPromiseWith(captured)(
            Effect.flatMap(Effect.forkIn(Scope.provide(work, owner), owner), (fiber) =>
                Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
            ),
            { signal }
        );
    const decryption = yield* makeLiveDecryption({
        ir,
        replica,
        backend: {
            sourceId: options.sourceId ?? replica.sourceId,
            encrypted: options.encrypted,
        },
    });
    const wait = (id: string, until: "accepted" | "confirmed" = "confirmed") =>
        replica
            .awaitAction(id, { until })
            .pipe(Effect.map((receipt) => (receipt ? actionResult(receipt) : undefined)));
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
            replica.enqueue(invocation, {
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
        if (options.awaitParentAcceptance) await accepted;
        return { entry: toEntry(entry, replica.mode === "protocol"), accepted, completed };
    };
    const outbox: OntologyOutbox = {
        collection: pendingCollection,
        ready: Promise.resolve(),
        enqueue: async <A>(
            request: Omit<OntologyActionRequest, "idempotencyKey"> & { idempotencyKey?: string },
            settings?: { visibility?: "confirmed" | "optimistic" }
        ) => {
            const result = await enqueue(request, settings?.visibility);
            return { ...result, completed: result.completed as Promise<A> };
        },
        remove: (id, settings) =>
            run(
                control(id).pipe(
                    Effect.flatMap((target) =>
                        target
                            .remove(id, settings)
                            .pipe(
                                Effect.andThen(
                                    target === replica
                                        ? Effect.void
                                        : replica
                                              .acknowledgeParentRemoval(id)
                                              .pipe(Effect.andThen(replica.syncOnce))
                                )
                            )
                    )
                )
            ),
        reconcile: (id, receipt) => run(command(id, (target) => target.reconcile(id, receipt))),
        retry: (id, settings) => run(command(id, (target) => target.retry(id, settings))),
        wait: <A>(id: string, settings?: { until?: "accepted" | "confirmed"; signal?: AbortSignal }) =>
            run(wait(id, settings?.until), settings?.signal) as Promise<A | void>,
        edit: async (id, update) => {
            const entry = (await run(visiblePending)).find((entry) => entry.invocation.id === id);
            if (!entry) throw new Error("Outbox entry is unavailable.");
            const request = structuredClone(toEntry(entry).request);
            update(request);
            const invocation = { id, name: request.actionTypeName, parameters: request.parameters };
            await run(command(id, (target) => target.edit(id, invocation)));
            const updated = (await run(visiblePending)).find((entry) => entry.invocation.id === id);
            return toEntry(
                updated ?? { ...entry, invocation, state: "queued", failure: undefined },
                updated?.forwarding ?? entry.forwarding
            );
        },
        cleanup: () => Promise.resolve(),
    };
    const actions = Object.fromEntries(
        ir.actionTypes.map((action) => [
            action.name,
            createLiveOntologyAction({
                ir,
                action,
                context,
                objects,
                resolveParameters: options.resolveActionParameters
                    ? (name, parameters) => run(options.resolveActionParameters!(name, parameters))
                    : undefined,
                submit: async (request, settings) => {
                    const visibility =
                        settings?.visibility ?? options.writes?.defaultVisibility ?? "confirmed";
                    const mode = settings?.mode ?? options.writes?.defaultMode ?? "direct";
                    if (mode === "direct" && !(await run(services.online)))
                        throw new BackendError({
                            operation: "applyAction",
                            kind: "Unavailable",
                            message: "Direct actions require connectivity. Use outbox mode to queue offline.",
                            retryable: true,
                            actionOutcome: "not-committed",
                        });
                    const queued = await enqueue(request, visibility);
                    return queued.completed;
                },
                validate: options.validate
                    ? (name, parameters) => run(options.validate!(name, parameters, persistedObjects))
                    : async () => ({ certain: false as const }),
                validateDraft: options.validateDraft
                    ? (name, parameters, settings) =>
                          run(
                              options.validateDraft!(
                                  name,
                                  parameters,
                                  settings?.knownParameters ?? [],
                                  persistedObjects
                              )
                          )
                    : async () => ({ certain: false as const }),
            }),
        ])
    );
    return {
        dbClient,
        ir,
        context,
        objects,
        persistedObjects,
        actions,
        outbox,
        attachments: options.attachments,
        decrypt: async (value, settings) =>
            (await run(
                options.decrypt
                    ? Effect.flatMap(options.decrypt(value, settings), (wire) =>
                          Effect.try({
                              try: () => encryptedPropertyCodec(ir, value).decode(wire),
                              catch: () =>
                                  new BackendError({
                                      operation: "ontology.decrypt",
                                      kind: "ValidationFailed",
                                      message: "Invalid decrypted value.",
                                      retryable: false,
                                  }),
                          })
                      )
                    : decryption.decrypt(value, settings),
                settings?.signal
            )) as never,
        queryFunctions: Object.fromEntries(
            ir.queryFunctionTypes.map((query) => [
                query.name,
                (parameters: Record<string, unknown>) => run(options.queryFunction(query.name, parameters)),
            ])
        ),
        ready: Promise.resolve(),
        traces: options.traces,
        diagnostics: {
            label: options.diagnosticLabel,
            role: replica.mode === "adapter" ? "host" : "replica",
            location: "In process",
            replica: replicaMonitor,
            traces: options.traces,
            parent: options.parentDiagnostics,
        },
        storage: replica,
    };
});
