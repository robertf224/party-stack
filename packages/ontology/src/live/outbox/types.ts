import type { Collection } from "@tanstack/db";

export type OntologyOutboxStatus = "queued" | "executing" | "failed";

export class NonRetryableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "NonRetryableError";
    }
}

export interface OntologyActionRequest {
    actionTypeName: string;
    parameters: Record<string, unknown>;
    idempotencyKey: string;
}

export interface OntologyOutboxEntry {
    id: string;
    sequence: number;
    request: OntologyActionRequest;
    visibility?: "confirmed" | "optimistic";
    status: OntologyOutboxStatus;
    createdAt: number;
    updatedAt: number;
    attempts: number;
    retryable: boolean;
    nextAttemptAt: number;
    executionId?: string;
    lastError?: {
        name: string;
        message: string;
    };
}

export interface EnqueuedOntologyAction<Result = unknown> {
    entry: OntologyOutboxEntry;
    completed: Promise<Result>;
}

export interface OntologyOutbox {
    readonly collection: Collection<OntologyOutboxEntry, string>;
    readonly ready: Promise<void>;
    enqueue<Result = unknown>(
        request: Omit<OntologyActionRequest, "idempotencyKey"> & {
            idempotencyKey?: string;
        },
        options?: {
            visibility?: "confirmed" | "optimistic";
        }
    ): Promise<EnqueuedOntologyAction<Result>>;
    edit(id: string, update: (request: OntologyActionRequest) => void): Promise<OntologyOutboxEntry>;
    remove(id: string): Promise<void>;
    retry(id: string): Promise<void>;
    cleanup(): Promise<void>;
}
