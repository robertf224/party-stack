import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { makeReplica, type ReplicaOptions, type ReplicaService } from "@party-stack/ontology-replica";
import { Runtime } from "@party-stack/runtime";
import { Effect, Queue, Scope, Stream } from "effect";
import { prepareActionParameters } from "../live/actions/prepareActionParameters.js";
import { unsupportedOntologyAttachmentsAdapter } from "../live/attachments/unsupportedOntologyAttachmentsAdapter.js";
import { createBlobManager } from "./blobs/createBlobManager.js";
import { observeReplicaRows } from "./hostQuery.js";
import { executeTransactionMutator } from "./transactions.js";
import type { LiveOntologyWrites } from "../live/LiveOntology.js";
import type { OntologyBackendAdapter, OntologyAttachmentsAdapter } from "../live/OntologyBackendAdapter.js";
import type { BlobManager } from "./blobs/types.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
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
}
export interface ReplicaHostService {
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly blobManager: BlobManager;
    readonly attachmentsAdapter: OntologyAttachmentsAdapter;
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
    const attachmentsAdapter: OntologyAttachmentsAdapter =
        backendAdapter.attachments ??
        (backend.attachments
            ? {
                  generateAttachmentId: () => crypto.randomUUID(),
                  getAttachmentContent: (value, settings) =>
                      Effect.runPromiseWith(captured)(backend.attachments!.read(value), {
                          signal: settings?.signal,
                      }),
                  getAttachmentMetadata: (value, _selection, settings) =>
                      Effect.runPromiseWith(captured)(backend.attachments!.metadata(value), {
                          signal: settings?.signal,
                      }),
              }
            : unsupportedOntologyAttachmentsAdapter);
    const scope = yield* Effect.scope;
    const blobManager = yield* Effect.acquireRelease(
        Effect.sync(() =>
            createBlobManager({
                runtime,
                scope,
                gcTime: 5 * 60_000,
                remote: {
                    read: (id, readOptions) =>
                        attachmentsAdapter.getAttachmentContent(
                            { ...(readOptions?.meta?.attachment as attachment | undefined), id },
                            { signal: readOptions?.signal }
                        ),
                    metadata: attachmentsAdapter.getAttachmentMetadata
                        ? (id, readOptions) =>
                              attachmentsAdapter.getAttachmentMetadata!(
                                  { ...(readOptions?.meta?.attachment as attachment | undefined), id },
                                  readOptions?.select ?? ["size", "type", "name"],
                                  { signal: readOptions?.signal }
                              )
                        : undefined,
                },
            })
        ),
        (manager) => Effect.promise(() => manager.cleanup())
    );
    yield* attempt(() => blobManager.ready);
    const connected = options.connection
        ? Stream.callback<boolean>((queue) =>
              Effect.acquireRelease(
                  Effect.sync(() => {
                      const unsubscribe = options.connection!.subscribe((state) => {
                          Queue.offerUnsafe(queue, state.status === "active");
                      });
                      Queue.offerUnsafe(queue, options.connection!.state.status === "active");
                      return unsubscribe;
                  }),
                  (unsubscribe) => Effect.sync(unsubscribe)
              )
          )
        : Stream.never;
    const replica = yield* makeReplica({
        namespace: runtime.namespace,
        ir,
        tables: services.tables,
        backend: {
            ...backend,
            invoke: (invocation) =>
                Effect.gen(function* () {
                    const prepared = yield* attempt(() =>
                        prepareActionParameters({
                            ir,
                            actionTypeName: invocation.name,
                            parameters: invocation.parameters,
                            backendAdapter,
                            blobManager,
                        })
                    ).pipe(
                        Effect.mapError(
                            (error) =>
                                new BackendError({
                                    operation: error.operation,
                                    kind: error.kind,
                                    message: error.message,
                                    retryable: error.retryable,
                                    cause: error.cause,
                                    invocationOutcome: "not-committed",
                                })
                        )
                    );
                    const receipt = yield* backend.invoke({
                        ...invocation,
                        parameters: prepared.parameters,
                        attachmentUploads: prepared.attachmentUploads,
                    });
                    const mappings = [
                        ...prepared.attachmentIdMappings,
                        ...(receipt.attachmentIdMappings ?? []),
                    ];
                    return { ...receipt, attachmentIdMappings: mappings.length ? mappings : undefined };
                }),
        },
        blobs: yield* attempt(() => blobManager.storage),
        execute: (tx, invocation, settings) =>
            executeTransactionMutator({
                ir,
                tx,
                name: invocation.name,
                parameters: invocation.parameters,
                invocationId: invocation.id,
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
        attachmentsAdapter,
        observe: (subset, settings) => observeReplicaRows(replica, subset, settings),
    };
});
