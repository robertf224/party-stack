import { BackendError } from "@party-stack/ontology-backend";
import { Runtime } from "@party-stack/runtime";
import { Effect } from "effect";
import { makeBlobManager } from "./attachments/manager.js";
import { prepareActionParameters } from "./attachments/prepare.js";
import { makeReplica } from "./service.js";
import type { BlobManagerService } from "./attachments/manager.js";
import type { ReplicaService } from "./service.js";
import type { ReplicaOptions } from "./service.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { ClientSubmission, OntologySource } from "@party-stack/ontology-backend/protocol";
import type { AttachmentTypeDef } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { ByteInput } from "@party-stack/ontology-storage/blobs";
import type { Scope } from "effect";

export interface ReplicaHostOptions extends Omit<
    ReplicaOptions,
    "namespace" | "tables" | "blobs" | "connectivity" | "backend" | "source"
> {
    readonly id?: string;
    readonly backend: OntologyBackendService;
    readonly source?: OntologySource;
}
/** Shared native composition. Platform resources, bytes, replay and background work share the caller's Scope. */
export const makeReplicaHost = Effect.fn("ReplicaHost.open")(function* (
    options: ReplicaHostOptions
): Effect.fn.Return<
    {
        replica: ReplicaService;
        backend: OntologyBackendService;
        blobManager: BlobManagerService;
        stageAttachment?: (
            value: attachment,
            bytes: ByteInput,
            target?: AttachmentTypeDef
        ) => Effect.Effect<attachment, BackendError>;
    },
    BackendError,
    Runtime | Scope.Scope
> {
    const runtime = yield* Runtime;
    const { ir, backend } = options;
    const unavailable = () =>
        new BackendError({
            operation: "attachment.read",
            kind: "NotImplemented",
            retryable: false,
            message: "Attachment reads are unavailable.",
        });
    const stageAttachment = backend.attachments?.stage
        ? (value: attachment, bytes: ByteInput, target?: AttachmentTypeDef) =>
              backend.attachments!.stage!(value, bytes, { target })
        : undefined;
    const blobManager = yield* makeBlobManager({
        gcTime: 5 * 60_000,
        remote: {
            read: (id, settings) =>
                backend.attachments?.read({
                    ...(settings?.meta?.attachment as attachment | undefined),
                    id,
                }) ?? Effect.fail(unavailable()),
            metadata: backend.attachments
                ? (id, settings) =>
                      backend.attachments!.metadata(
                          { ...(settings?.meta?.attachment as attachment | undefined), id },
                          { select: settings?.select }
                      )
                : undefined,
        },
    });
    const prepare = (name: string, parameters: Record<string, unknown>) =>
        prepareActionParameters({ ir, actionTypeName: name, parameters, blobManager });
    const withStagedAttachments =
        <A>(submit: (request: ClientSubmission) => Effect.Effect<A, BackendError>) =>
        (request: ClientSubmission) =>
            Effect.gen(function* () {
                const prepared = yield* prepare(request.invocation.name, request.invocation.parameters);
                const submission = {
                    ...request,
                    stagedAttachments: prepared.attachmentUploads.map((u) => u.attachment.id),
                };
                const result = yield* Effect.result(submit(submission));
                if (result._tag === "Success") return result.success;
                if (
                    result.failure.kind !== "NotFound" ||
                    result.failure.operation !== "replica.submit.attachments"
                )
                    return yield* result.failure;
                for (const upload of prepared.attachmentUploads) {
                    if (!stageAttachment) return yield* unavailable();
                    const staged = yield* stageAttachment(upload.attachment, upload.blob, upload.target);
                    if (staged.id !== upload.attachment.id)
                        return yield* new BackendError({
                            operation: "attachment.handoff",
                            kind: "Conflict",
                            retryable: false,
                            actionOutcome: "not-committed",
                            message: "A speculative parent must preserve staged attachment IDs.",
                        });
                }
                return yield* submit(submission);
            });
    const replica = yield* makeReplica({
        ...options,
        namespace: options.id ?? runtime.namespace,
        tables: runtime.tables,
        blobs: blobManager.storage,
        connectivity: runtime.connectivity,
        clients: options.clients ?? { sessionIdleTimeoutMs: 10 * 60_000 },
        ...(options.source
            ? {
                  source: {
                      ...options.source,
                      submit: withStagedAttachments(options.source.submit),
                      accept: options.source.accept
                          ? withStagedAttachments(options.source.accept)
                          : undefined,
                  },
                  backend: undefined,
              }
            : {
                  backend: {
                      ...backend,
                      applyAction: (request) =>
                          Effect.gen(function* () {
                              const prepared = yield* prepare(request.name, request.parameters).pipe(
                                  Effect.mapError(
                                      (error) =>
                                          new BackendError({
                                              operation: error.operation,
                                              kind: error.kind,
                                              message: error.message,
                                              retryable: error.retryable,
                                              issues: error.issues,
                                              cause: error.cause,
                                              actionOutcome: "not-committed",
                                          })
                                  )
                              );
                              return yield* backend.applyAction({
                                  ...request,
                                  parameters: prepared.parameters,
                                  attachmentUploads: prepared.attachmentUploads,
                              });
                          }),
                  },
                  source: undefined,
              }),
    });
    return { replica, backend, blobManager, stageAttachment };
});
