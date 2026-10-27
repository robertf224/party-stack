import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Schedule, Stream } from "effect";
import type { OntologyOperationsClient } from "./operations.js";
import type { OntologyDescription, OntologyRpcClient } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

/** Committed-data/finite-operation facet shared by every RPC transport. */
export function makeRpcBackend(
    client: OntologyRpcClient,
    description: OntologyDescription,
    operations: OntologyOperationsClient
): OntologyBackendService {
    const boundary = <A>(run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => classifyBackendFailure("remote.attachment", cause) });
    const reconnect = Schedule.spaced(1_000).pipe(
        Schedule.while(({ input }: Schedule.InputMetadata<BackendError>) => Effect.succeed(input.retryable))
    );
    const hints = (stream: Stream.Stream<void, BackendError>) =>
        Stream.concat(
            stream,
            Stream.fail(
                new BackendError({
                    operation: "remote.watch",
                    kind: "Unavailable",
                    retryable: true,
                    message: "Subscription ended; reconnecting.",
                })
            )
        ).pipe(Stream.retry(reconnect));
    return {
        attachments: {
            stage: (value, bytes) =>
                boundary(
                    async () =>
                        (
                            await operations.attachments.create(bytes, {
                                id: value.id,
                                eager: description.replication === "committed",
                            })
                        ).attachment
                ),
            read: (value, range) =>
                boundary(async (signal) => {
                    const source = await operations.attachments.source(value, { signal });
                    return range ? sliceByteSource(source, range.offset ?? 0, range.length) : source;
                }),
            metadata: (value, settings) =>
                client
                    .AttachmentMetadata({ attachment: value, select: settings?.select })
                    .pipe(
                        Effect.mapError((cause) =>
                            classifyBackendFailure("remote.attachment.metadata", cause)
                        )
                    ),
        },
        encrypted: {
            decrypt: (value) =>
                operations.decrypt(value).pipe(Effect.map((plaintext) => ({ value: plaintext }))),
        },
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
                      ? hints(
                            client.WatchChanges().pipe(
                                Stream.map(() => undefined),
                                Stream.mapError((cause) => classifyBackendFailure("remote.changes", cause))
                            )
                        )
                      : undefined,
              }
            : undefined,
        watchSubset: description.watchSubset
            ? (subset) =>
                  hints(
                      client.WatchSubset(subset).pipe(
                          Stream.map(() => undefined),
                          Stream.mapError((cause) => classifyBackendFailure("remote.watchSubset", cause))
                      )
                  )
            : undefined,
        loadSubset: (subset) =>
            client
                .LoadSubset(subset)
                .pipe(Effect.mapError((cause) => classifyBackendFailure("remote.request", cause))),
        applyAction: Effect.fn("OntologyBackend.invokeRemote")(function* (invocation) {
            for (const upload of invocation.attachmentUploads ?? []) {
                const staged = yield* boundary(
                    async () =>
                        (await operations.attachments.create(upload.blob, { id: upload.attachment.id }))
                            .attachment
                );
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
