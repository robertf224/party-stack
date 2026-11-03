import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Stream } from "effect";
import type { OntologyOperationsClient } from "./operations.js";
import type { OntologyDescription, OntologyRpcClient } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

/** Committed-data/finite-operation facet shared by every RPC transport. */
export function makeRpcBackend(
    client: OntologyRpcClient,
    description: OntologyDescription,
    operations: OntologyOperationsClient
): OntologyBackendService {
    // One stream represents one attempt, like every other adapter. Replica watch
    // supervision must see EOF/errors to invalidate coverage and apply retry policy.
    return {
        attachments: description.attachments
            ? {
                  stage: description.attachments.stage
                      ? (value, bytes) =>
                            operations.attachments
                                .create(bytes, {
                                    id: value.id,
                                    eager: description.replication === "committed",
                                })
                                .pipe(Effect.map((created) => created.attachment))
                      : undefined,
                  read: (value, range) =>
                      operations.attachments
                          .source(value)
                          .pipe(
                              Effect.map((source) =>
                                  range ? sliceByteSource(source, range.offset ?? 0, range.length) : source
                              )
                          ),
                  metadata: (value, settings) =>
                      client
                          .AttachmentMetadata({ attachment: value, select: settings?.select })
                          .pipe(
                              Effect.mapError((cause) =>
                                  classifyBackendFailure("remote.attachment.metadata", cause)
                              )
                          ),
              }
            : undefined,
        encrypted: description.encrypted
            ? {
                  decrypt: (value) =>
                      client
                          .Decrypt({ value })
                          .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.decrypt", cause))),
              }
            : undefined,
        name: "protocol",
        sourceId: description.sourceId,
        supportsIdempotency: description.supportsIdempotency,
        resolveActionParameters: description.actionParameterResolution
            ? operations.resolveActionParameters
            : undefined,
        changes: description.changes
            ? {
                  pull: (request) =>
                      client
                          .PullChanges(request)
                          .pipe(
                              Effect.mapError((cause) => classifyBackendFailure("remote.pullChanges", cause))
                          ),
                  watch: description.watchChanges
                      ? client.WatchChanges().pipe(
                            Stream.map(() => undefined),
                            Stream.mapError((cause) => classifyBackendFailure("remote.changes", cause))
                        )
                      : undefined,
              }
            : undefined,
        watchSubset: description.watchSubset
            ? (subset) =>
                  client.WatchSubset(subset).pipe(
                      Stream.map(() => undefined),
                      Stream.mapError((cause) => classifyBackendFailure("remote.watchSubset", cause))
                  )
            : undefined,
        subscribeSelection: description.delivery
            ? (selection, _policy, resume) =>
                  Effect.succeed({
                      frames: client
                          .SubscribeSelection({ selection, resume })
                          .pipe(Stream.mapError((cause) => classifyBackendFailure("remote.delivery", cause))),
                      acknowledge: (position) =>
                          client
                              .AckDelivery({ kind: "committed", position })
                              .pipe(
                                  Effect.mapError((cause) => classifyBackendFailure("remote.delivery", cause))
                              ),
                  })
            : undefined,
        acknowledgeDelivery: description.delivery
            ? (position) =>
                  client
                      .AckDelivery({ kind: "committed", position })
                      .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.delivery", cause)))
            : undefined,
        loadSubset: (subset) =>
            client
                .LoadSubset(subset)
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
        applyAction: Effect.fn("OntologyBackend.invokeRemote")(function* (invocation) {
            for (const upload of invocation.attachmentUploads ?? []) {
                const { attachment: staged } = yield* operations.attachments.create(upload.blob, {
                    id: upload.attachment.id,
                });
                // Local storage parents preserve handles. HTTP multipart remains the
                // atomic provider path when uploads require parameter canonicalization.
                if (staged.id !== upload.attachment.id)
                    return yield* new BackendError({
                        operation: "applyAction.upload",
                        kind: "NotImplemented",
                        retryable: false,
                        actionOutcome: "not-committed",
                        message: "This transport requires attachment staging to preserve its handle.",
                    });
            }
            return yield* client
                .ApplyAction({ ...invocation, attachmentUploads: undefined })
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.applyAction", cause)));
        }),
        queryFunction: (name, parameters) =>
            client
                .QueryFunction({ name, parameters })
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
        validateAction: (name, parameters, settings) =>
            client
                .ValidateAction({ name, parameters, knownParameters: settings?.knownParameters })
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
    };
}
