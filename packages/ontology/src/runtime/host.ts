import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { makeReplica, type ReplicaOptions, type ReplicaService } from "@party-stack/ontology-replica";
import { Runtime } from "@party-stack/runtime";
import { Effect, Fiber, Scope, Stream } from "effect";
import { prepareActionParameters } from "../live/actions/prepareActionParameters.js";
import { createBlobManager } from "./blobs/createBlobManager.js";
import { observeReplicaRows } from "./hostQuery.js";
import { executeTransactionMutator } from "./transactions.js";
import type { LiveOntologyWrites } from "../live/LiveOntology.js";
import type { OntologyBackendAdapter } from "../live/OntologyBackendAdapter.js";
import type { BlobManager } from "./blobs/types.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { ByteInput } from "@party-stack/ontology-storage/blobs";
import type { RuntimeAdapter } from "@party-stack/runtime";

const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "ontology",
              kind: "Unavailable",
              message: cause instanceof Error ? cause.message : "Ontology operation failed.",
              retryable: true,
              cause,
          });
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });

export interface ReplicaHostOptions {
    readonly ir: OntologyIR;
    readonly context: Record<string, unknown>;
    /** The caller owns provider acquisition/cleanup; open(context) acquires native backend resources in this Scope. */
    readonly backendAdapter: OntologyBackendAdapter;
    readonly runtime: RuntimeAdapter;
    readonly writes?: LiveOntologyWrites;
    readonly connection?: ConnectionMonitor;
    readonly gc?: ReplicaOptions["gc"];
    readonly clients?: ReplicaOptions["clients"];
}
export interface ReplicaHostService {
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly blobManager: BlobManager;
    readonly stageAttachment?: (
        value: attachment,
        bytes: ByteInput,
        target?: import("@party-stack/ontology-spec").AttachmentTypeDef
    ) => Promise<attachment>;
    readonly observe: (
        subset: import("@party-stack/ontology-backend").BackendSubset,
        options?: { readonly persistedOnly?: boolean }
    ) => Stream.Stream<
        readonly import("@party-stack/ontology-storage").Row<Record<string, unknown>>[],
        BackendError
    >;
}

/** Owned service composition, independent of the application's collection materialization. */
export const makeReplicaHost = Effect.fn("OntologyHost.open")(function* (
    options: ReplicaHostOptions
): Effect.fn.Return<ReplicaHostService, BackendError, Runtime | Scope.Scope> {
    const services = yield* Runtime;
    const { runtime, context, ir, backendAdapter } = options;
    const backend = yield* backendAdapter.open(context);
    const captured = yield* Effect.context<never>();
    const scope = yield* Effect.scope;
    const run = <A>(effect: Effect.Effect<A, BackendError>, signal?: AbortSignal) =>
        Effect.runPromiseWith(captured)(
            Effect.flatMap(Effect.forkIn(effect, scope), (fiber) =>
                Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
            ),
            { signal }
        );
    const unavailableAttachment = () =>
        new BackendError({
            operation: "attachment.read",
            kind: "NotImplemented",
            message: "Attachment reads are unavailable.",
            retryable: false,
        });
    const stageAttachment = backend.attachments?.stage
        ? (
              value: attachment,
              bytes: ByteInput,
              target?: import("@party-stack/ontology-spec").AttachmentTypeDef
          ) => run(backend.attachments!.stage!(value, bytes, { target }))
        : undefined;
    const blobManager = yield* Effect.acquireRelease(
        Effect.sync(() =>
            createBlobManager({
                runtime,
                scope,
                gcTime: 5 * 60_000,
                remote: {
                    read: (id, settings) =>
                        run(
                            backend.attachments?.read({
                                ...(settings?.meta?.attachment as attachment | undefined),
                                id,
                            }) ?? Effect.fail(unavailableAttachment()),
                            settings?.signal
                        ),
                    metadata: backend.attachments
                        ? (id, settings) =>
                              run(
                                  backend.attachments!.metadata(
                                      { ...(settings?.meta?.attachment as attachment | undefined), id },
                                      { select: settings?.select }
                                  ),
                                  settings?.signal
                              )
                        : undefined,
                },
            })
        ),
        (manager) => Effect.promise(() => manager.cleanup())
    );
    yield* attempt(() => blobManager.ready);
    const connected = options.connection
        ? Stream.map(options.connection.changes, (state) => state.status === "active")
        : Stream.never;
    const replica = yield* makeReplica({
        namespace: runtime.namespace,
        clients: options.clients ?? { leaseMs: 10 * 60_000 },
        ir,
        tables: services.tables,
        backend: {
            ...backend,
            applyAction: (invocation) =>
                Effect.gen(function* () {
                    const prepared = yield* prepareActionParameters({
                        ir,
                        actionTypeName: invocation.name,
                        parameters: invocation.parameters,
                        blobManager,
                    }).pipe(
                        Effect.mapError(
                            (error) =>
                                new BackendError({
                                    operation: error.operation,
                                    kind: error.kind,
                                    message: error.message,
                                    retryable: error.retryable,
                                    cause: error.cause,
                                    actionOutcome: "not-committed",
                                })
                        )
                    );
                    const receipt = yield* backend.applyAction({
                        ...invocation,
                        parameters: prepared.parameters,
                        attachmentUploads: prepared.attachmentUploads,
                    });
                    return receipt;
                }),
        },
        blobs: yield* attempt(() => blobManager.storage),
        execute: (tx, invocation, settings) =>
            executeTransactionMutator({
                ir,
                tx,
                name: invocation.name,
                parameters: invocation.parameters,
                operationId: invocation.id,
                replay: invocation.replay,
                resolveOnly: settings?.optimistic === false,
                context,
                mutators: options.writes?.mutators,
            }),
        online: Effect.gen(function* () {
            return (
                (yield* services.online) &&
                (!options.connection || options.connection.state.status === "active")
            );
        }),
        connectivity: Stream.merge(services.connectivity, connected),
        gc: options.gc,
        outbox: options.writes?.outbox,
        externalChanges: services.externalChanges,
        publish: services.notify,
        registerOwner: runtime.actorLiveness
            ? (owner) => runtime.actorLiveness!.acquire(owner).pipe(Effect.mapError(failure))
            : undefined,
        isOwnerAlive: runtime.actorLiveness
            ? (owner) => runtime.actorLiveness!.isAlive(owner).pipe(Effect.mapError(failure))
            : undefined,
    });
    return {
        replica,
        backend,
        blobManager,
        stageAttachment,
        observe: (subset, settings) => observeReplicaRows(replica, subset, settings),
    };
});
