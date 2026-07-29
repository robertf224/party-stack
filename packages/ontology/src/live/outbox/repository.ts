import { CoordinationTaskRejectedError } from "@party-stack/runtime";
import { queryOnce, type Collection } from "@tanstack/db";
import type { OutboxErrorDetails } from "./service.js";
import type { OntologyActionRequest, OntologyOutboxEntry } from "./types.js";

export function requestFingerprint(request: OntologyActionRequest): string {
    return JSON.stringify(request);
}

export class OntologyOutboxRepository {
    constructor(readonly collection: Collection<OntologyOutboxEntry, string>) {}

    preload(): Promise<void> {
        return this.collection.preload();
    }

    get(id: string): OntologyOutboxEntry | undefined {
        return this.collection.get(id) as OntologyOutboxEntry | undefined;
    }

    entries(): Promise<OntologyOutboxEntry[]> {
        return queryOnce((query) =>
            query
                .from({ entry: this.collection })
                .orderBy(({ entry }) => entry.sequence, "asc")
                .select(({ entry }) => ({
                    id: entry.id,
                    sequence: entry.sequence,
                    request: entry.request,
                    visibility: entry.visibility,
                    status: entry.status,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    attempts: entry.attempts,
                    retryable: entry.retryable ?? true,
                    nextAttemptAt: entry.nextAttemptAt,
                    executionId: entry.executionId,
                    lastError: entry.lastError,
                }))
        ) as Promise<OntologyOutboxEntry[]>;
    }

    async enqueue(proposed: OntologyOutboxEntry): Promise<OntologyOutboxEntry> {
        const existing = this.get(proposed.id);
        if (existing) return existing;

        const entry = {
            ...proposed,
            sequence: await this.nextSequence(),
        };
        await this.collection.insert(entry, {
            optimistic: false,
        }).isPersisted.promise;
        return entry;
    }

    async edit(id: string, request: OntologyActionRequest): Promise<OntologyOutboxEntry> {
        const entry = this.get(id);
        if (!entry || !["queued", "failed"].includes(entry.status)) {
            throw new CoordinationTaskRejectedError(`Outbox entry "${id}" cannot be edited.`);
        }

        const now = Date.now();
        return this.update(id, (draft) => {
            draft.request = request;
            draft.status = "queued";
            draft.retryable = true;
            draft.attempts = 0;
            draft.executionId = undefined;
            draft.nextAttemptAt = now;
            draft.updatedAt = now;
            draft.lastError = undefined;
        });
    }

    async remove(id: string): Promise<void> {
        const entry = this.get(id);
        if (entry && !["queued", "failed"].includes(entry.status)) {
            throw new CoordinationTaskRejectedError(
                `Outbox entry "${id}" cannot be removed while it is ${entry.status}.`
            );
        }
        await this.delete(id);
    }

    async retry(id: string): Promise<void> {
        const entry = this.get(id);
        if (!entry?.retryable) {
            throw new CoordinationTaskRejectedError(`Outbox entry "${id}" is not retriable.`);
        }
        if (entry.status === "executing") {
            throw new CoordinationTaskRejectedError(`Outbox entry "${id}" is already executing.`);
        }

        const now = Date.now();
        await this.update(id, (draft) => {
            draft.status = "queued";
            draft.executionId = undefined;
            draft.nextAttemptAt = now;
            draft.updatedAt = now;
            draft.lastError = undefined;
        });
    }

    async recover(
        failureStrategy:
            | "pause"
            | "discard-all",
        maxRetries: number
    ): Promise<OntologyOutboxEntry[]> {
        const entries = await this.entries();
        const head = entries[0];
        if (!head) return [];

        const interrupted =
            head.status === "executing" ||
            head.lastError?.name ===
                "InterruptedExecution";
        const exhausted =
            head.status === "failed" &&
            (!head.retryable ||
                head.attempts > maxRetries ||
                head.lastError?.name ===
                    "ProjectionRestoreError");
        if (
            failureStrategy === "discard-all" &&
            (interrupted || exhausted)
        ) {
            await this.deleteEntries(entries);
            return entries;
        }

        if (
            head.status === "failed" &&
            head.retryable &&
            head.attempts <= maxRetries
        ) {
            const now = Date.now();
            await this.update(head.id, (draft) => {
                draft.status = "queued";
                draft.executionId = undefined;
                draft.nextAttemptAt = now;
                draft.updatedAt = now;
            });
            return [];
        }

        if (head.status === "executing") {
            const now = Date.now();
            await this.update(head.id, (draft) => {
                draft.status = "failed";
                draft.retryable = true;
                draft.executionId = undefined;
                draft.updatedAt = now;
                draft.lastError = {
                    name: "InterruptedExecution",
                    message: "Execution was interrupted; retry manually.",
                };
            });
        }
        return [];
    }

    async claim(): Promise<OntologyOutboxEntry | undefined> {
        const entry = await this.head();
        if (entry?.status !== "queued" || entry.nextAttemptAt > Date.now()) {
            return;
        }

        const executionId = crypto.randomUUID();
        return this.update(entry.id, (draft) => {
            draft.status = "executing";
            draft.executionId = executionId;
            draft.updatedAt = Date.now();
        });
    }

    async nextRetryAt(): Promise<
        number | undefined
    > {
        const entry = await this.head();
        return entry?.status === "queued"
            ? entry.nextAttemptAt
            : undefined;
    }

    async complete(id: string, executionId: string): Promise<void> {
        this.assertCurrentExecution(id, executionId);
        await this.delete(id);
    }

    async fail(
        id: string,
        executionId: string,
        retryable: boolean,
        error: OutboxErrorDetails,
        retryAt?: number
    ): Promise<OntologyOutboxEntry> {
        const entry = this.assertCurrentExecution(id, executionId);
        const now = Date.now();
        return this.update(id, (draft) => {
            draft.status =
                retryAt === undefined
                    ? "failed"
                    : "queued";
            draft.retryable = retryable;
            draft.attempts = entry.attempts + 1;
            draft.executionId = undefined;
            draft.nextAttemptAt =
                retryAt ?? now;
            draft.updatedAt = now;
            draft.lastError = error;
        });
    }

    async discardAll(
        id: string,
        executionId: string
    ): Promise<OntologyOutboxEntry[]> {
        this.assertCurrentExecution(
            id,
            executionId
        );
        return this.discardFrom(id);
    }

    async discardFrom(
        id: string
    ): Promise<OntologyOutboxEntry[]> {
        const failed = this.get(id);
        if (!failed) return [];
        const discarded = (
            await this.entries()
        ).filter(
            (entry) =>
                entry.sequence >= failed.sequence
        );
        await this.deleteEntries(discarded);
        return discarded;
    }

    private async head(): Promise<OntologyOutboxEntry | undefined> {
        return (await queryOnce((query) =>
            query
                .from({ entry: this.collection })
                .orderBy(({ entry }) => entry.sequence, "asc")
                .select(({ entry }) => ({
                    id: entry.id,
                    sequence: entry.sequence,
                    request: entry.request,
                    visibility: entry.visibility,
                    status: entry.status,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    attempts: entry.attempts,
                    retryable: entry.retryable ?? true,
                    nextAttemptAt: entry.nextAttemptAt,
                    executionId: entry.executionId,
                    lastError: entry.lastError,
                }))
                .findOne()
        )) as OntologyOutboxEntry | undefined;
    }

    private async nextSequence(): Promise<number> {
        const latest = (await queryOnce((query) =>
            query
                .from({ entry: this.collection })
                .orderBy(({ entry }) => entry.sequence, "desc")
                .select(({ entry }) => ({
                    sequence: entry.sequence,
                }))
                .findOne()
        )) as { sequence: number } | undefined;
        return (latest?.sequence ?? 0) + 1;
    }

    private assertCurrentExecution(id: string, executionId: string): OntologyOutboxEntry {
        const entry = this.get(id);
        if (entry?.status !== "executing" || entry.executionId !== executionId) {
            throw new CoordinationTaskRejectedError(
                `Outbox execution claim for "${id}" is no longer current.`,
                "STALE_EXECUTION"
            );
        }
        return entry;
    }

    private async update(
        id: string,
        update: (draft: OntologyOutboxEntry) => void
    ): Promise<OntologyOutboxEntry> {
        const transaction = this.collection.update(id, { optimistic: false }, update);
        await transaction.isPersisted.promise;
        const entry = this.get(id);
        if (!entry) {
            throw new Error(`Outbox entry "${id}" disappeared during an update.`);
        }
        return entry;
    }

    private async delete(id: string): Promise<void> {
        if (!this.collection.has(id)) return;
        await this.collection.delete(id, {
            optimistic: false,
        }).isPersisted.promise;
    }

    private async deleteEntries(
        entries: readonly OntologyOutboxEntry[]
    ): Promise<void> {
        if (entries.length === 0) return;
        await this.collection.delete(
            entries.map((entry) => entry.id),
            { optimistic: false }
        ).isPersisted.promise;
    }
}
