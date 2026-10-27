import { BackendError, ActionReceiptSchema, DecryptedValueSchema } from "@party-stack/ontology-backend";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect, Schema } from "effect";
import { RemoteOntologyError } from "./errors.js";
import type { RemoteOntologyTransport } from "./protocol.js";
import type { OntologyIR } from "@party-stack/ontology";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

const failure = (operation: string, cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation,
              kind:
                  cause instanceof RemoteOntologyError && !cause.retryable
                      ? cause.name === "HistoryExpired"
                          ? "HistoryExpired"
                          : cause.name === "Conflict"
                            ? "Conflict"
                            : cause.name === "NotImplemented"
                              ? "NotImplemented"
                              : cause.code === "NOT_FOUND"
                                ? "NotFound"
                                : "ValidationFailed"
                      : "Unavailable",
              message:
                  cause instanceof RemoteOntologyError ? cause.message : "Remote ontology request failed.",
              retryable: cause instanceof RemoteOntologyError ? cause.retryable : true,
              cause,
          });
const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) }).pipe(
        Effect.withSpan(`RemoteOntology.${operation}`)
    );

/** Effect protocol over the policy-enforcing transport. No client collection is needed for invocation. */
export function makeRemoteOntologyBackend(options: {
    readonly ir: OntologyIR;
    readonly transport: RemoteOntologyTransport;
    readonly sourceId?: string;
    /** Configure only when the server actually stores durable invocation receipts. */
    readonly supportsIdempotency?: boolean;
    readonly journal?: boolean;
}): Effect.Effect<OntologyBackendService> {
    const { transport, ir } = options;
    const backend: OntologyBackendService = {
        name: "remote",
        sourceId: options.sourceId ?? transport.sourceId ?? "remote",
        supportsIdempotency: options.supportsIdempotency ?? false,
        loadSubset: (subset) =>
            Effect.gen(function* () {
                const definition = ir.objectTypes.find((object) => object.name === subset.objectType);
                if (!definition)
                    return yield* failure(
                        "loadSubset",
                        new BackendError({
                            operation: "loadSubset",
                            kind: "ValidationFailed",
                            message: "Unknown object type.",
                            retryable: false,
                        })
                    );
                // The compatibility transport still speaks TanStack query IR. A complete policy-filtered
                // snapshot is safe to evaluate locally while the protocol moves to ontology query IR.
                if (options.journal && transport.replicaSnapshot) {
                    const snapshot = yield* request("snapshot", (signal) =>
                        transport.replicaSnapshot!({ objectType: subset.objectType }, { signal })
                    );
                    return { ...snapshot, rows: evaluateQuery(snapshot.rows, subset.query ?? {}) };
                }
                const snapshot = yield* request("loadSubset", (signal) =>
                    transport.loadSubset({ objectType: subset.objectType }, { signal })
                );
                const rows = yield* Effect.try({
                    try: () =>
                        evaluateQuery(
                            snapshot.objects.map((value) => ({
                                key: value[definition.primaryKey] as string | number,
                                value,
                            })),
                            subset.query ?? {}
                        ),
                    catch: (cause) => failure("loadSubset", cause),
                });
                return { rows, complete: true };
            }),
        validateAction: (name, parameters, settings) =>
            settings?.knownParameters
                ? Effect.succeed({ certain: false as const })
                : request("validateAction", async (signal) => {
                      const report = await transport.validateAction(
                          { actionType: name, parameters },
                          { signal }
                      );
                      if (!report.certain) return { certain: false as const };
                      if (report.value.kind === "err")
                          return {
                              certain: true as const,
                              value: { kind: "err" as const, value: report.value.value },
                          };
                      return { certain: true as const, value: { kind: "ok" as const, value: undefined } };
                  }),
        applyAction: (invocation) =>
            Effect.gen(function* () {
                const response = yield* request("applyAction", (signal) =>
                    transport.applyAction(
                        {
                            actionType: invocation.name,
                            parameters: invocation.parameters,
                            idempotencyKey: invocation.id,
                            replay: invocation.replay,
                        },
                        {
                            signal,
                            attachments: invocation.attachmentUploads
                                ? [...invocation.attachmentUploads]
                                : undefined,
                        }
                    )
                );
                return yield* Schema.decodeUnknownEffect(ActionReceiptSchema)(
                    response.receipt ?? {
                        operationId: invocation.id,
                        outcome: "committed",
                        attachmentIdMappings: response.attachmentIdMappings,
                        affected: (
                            response.invalidatedObjectTypes ?? ir.objectTypes.map((type) => type.name)
                        ).map((objectType) => ({ objectType })),
                    }
                ).pipe(Effect.mapError((cause) => failure("receipt", cause)));
            }),
        queryFunction: (name, parameters) =>
            request(
                "queryFunction",
                async (signal) =>
                    (await transport.runQueryFunction({ queryFunctionType: name, parameters }, { signal }))
                        .value
            ),
        changes:
            options.journal && transport.pullChanges
                ? {
                      pull: (options) =>
                          request("pullChanges", (signal) => transport.pullChanges!(options, { signal })),
                  }
                : undefined,
        encrypted: transport.decrypt
            ? {
                  decrypt: (value) =>
                      request("decrypt", async (signal) =>
                          Schema.decodeUnknownSync(DecryptedValueSchema)(
                              await transport.decrypt!({ value }, { signal })
                          )
                      ).pipe(
                          Effect.mapError(
                              (error) =>
                                  new BackendError({
                                      operation: "decrypt",
                                      kind: error.kind,
                                      retryable: error.retryable,
                                      message: "Remote decryption failed.",
                                  })
                          )
                      ),
              }
            : undefined,
        attachments: {
            read: (attachment, range) =>
                request("attachment.read", async (signal) => {
                    const value = await transport.getAttachmentContent({ attachment }, { signal });
                    if (!range) return value;
                    if (
                        !Number.isSafeInteger(range.offset ?? 0) ||
                        (range.offset ?? 0) < 0 ||
                        (range.length !== undefined &&
                            (!Number.isSafeInteger(range.length) || range.length < 0))
                    )
                        throw new BackendError({
                            operation: "attachment.read",
                            kind: "ValidationFailed",
                            message: "Invalid byte range.",
                            retryable: false,
                        });
                    return value.slice(
                        range.offset ?? 0,
                        range.length === undefined ? undefined : (range.offset ?? 0) + range.length,
                        value.type
                    );
                }),
            metadata: (attachment) =>
                request("attachment.metadata", async (signal) => {
                    const value = await transport.getAttachmentMetadata(
                        { attachment, selection: ["size", "type", "name"] },
                        { signal }
                    );
                    if (value.size === undefined || value.type === undefined) {
                        const blob = await transport.getAttachmentContent({ attachment }, { signal });
                        return { size: blob.size, type: blob.type, name: value.name };
                    }
                    return { size: value.size, type: value.type, name: value.name };
                }),
        },
    };
    return Effect.succeed(backend);
}
