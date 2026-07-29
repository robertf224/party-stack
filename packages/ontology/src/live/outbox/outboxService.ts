import type {
    CoordinationHost,
    CoordinationServiceHandlers,
    CoordinationServiceServer,
} from "@party-stack/runtime";
import { OntologyOutboxRepository } from "./repository.js";
import {
    OUTBOX_COORDINATION_SERVICE,
    type OutboxCoordinationService,
    type OutboxResultEvent,
} from "./service.js";

export function serveOntologyOutbox(
    host: CoordinationHost,
    repository: OntologyOutboxRepository
): CoordinationServiceServer<OutboxCoordinationService> {
    let publishResult: (event: OutboxResultEvent) => void = () => undefined;
    const handlers: CoordinationServiceHandlers<OutboxCoordinationService> = {
        enqueue: ({ entry }) => repository.enqueue(entry),
        edit: ({ id, request }) => repository.edit(id, request),
        remove: async ({ id }) => {
            await repository.remove(id);
            publishResult({
                type: "rejected",
                id,
                error: {
                    name: "OutboxEntryRemoved",
                    message: "Outbox entry removed.",
                },
            });
        },
        retry: ({ id }) => repository.retry(id),
        recover: async ({
            failureStrategy,
            maxRetries,
        }) => {
            const discarded =
                await repository.recover(
                    failureStrategy,
                    maxRetries
                );
            for (const entry of discarded) {
                publishResult({
                    type: "rejected",
                    id: entry.id,
                    error: {
                        name: "InterruptedExecutionDiscarded",
                        message:
                            "Discarded because execution was interrupted before its result was recorded.",
                    },
                });
            }
        },
        claim: () => repository.claim(),
        nextRetryAt: () =>
            repository.nextRetryAt(),
        complete: async ({ id, executionId, result }) => {
            await repository.complete(id, executionId);
            publishResult({
                type: "completed",
                id,
                result,
            });
        },
        fail: async ({
            id,
            executionId,
            retryable,
            retryAt,
            error,
        }) => {
            const entry = await repository.fail(
                id,
                executionId,
                retryable,
                error,
                retryAt
            );
            if (!retryable) {
                publishResult({
                    type: "rejected",
                    id,
                    error,
                });
            }
            return entry;
        },
        discardAll: async ({
            id,
            executionId,
            error,
        }) => {
            const discarded =
                await repository.discardAll(
                    id,
                    executionId
                );
            for (const entry of discarded) {
                publishResult({
                    type: "rejected",
                    id: entry.id,
                    error:
                        entry.id === id
                            ? error
                            : {
                                  name: "OutboxDiscardedAfterNonRetryableError",
                                  message: `Discarded because outbox entry "${id}" failed permanently: ${error.message}`,
                              },
                });
            }
        },
    };

    const server = host.serve<OutboxCoordinationService>(OUTBOX_COORDINATION_SERVICE, handlers);
    publishResult = (event) => server.events.publish("result", event);
    return server;
}
