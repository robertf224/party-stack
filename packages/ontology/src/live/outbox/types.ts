import type { Collection } from "@tanstack/db";

export type OntologyOutboxStatus = import("@party-stack/ontology-backend/protocol").PendingAction["state"];

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
    replay?: import("../expression.js").ExpressionReplay;
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
    /** Forwarding retries belong to a different stage than upstream execution retries. */
    attemptStage?: "forwarding" | "execution";
    retryable: boolean;
    nextAttemptAt: number;
    executionId?: string;
    /** Retry may duplicate a previous remote execution unless the caller acknowledges it. */
    retryRequiresAcknowledgement?: boolean;
    lastError?: import("@party-stack/ontology-backend").BackendError;
}

export interface EnqueuedOntologyAction<Result = unknown> {
    entry: OntologyOutboxEntry;
    /** Immediate-parent acceptance; persistence depends on that parent's storage. */
    accepted: Promise<void>;
    /** Upstream commitment plus local read-back/journal settlement. */
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
    remove(id: string, options?: { allowUnknownOutcome?: boolean }): Promise<void>;
    /** Supply an independently verified remote receipt; read-back still runs normally. */
    reconcile(id: string, receipt: import("@party-stack/ontology-backend").ActionReceipt): Promise<void>;
    retry(id: string, options?: { allowUnknownOutcome?: boolean }): Promise<void>;
    /** Cancel/timeout the observation with an AbortSignal; the action remains queued. */
    wait<Result = unknown>(
        id: string,
        options?: {
            until?: "accepted" | "confirmed";
            signal?: AbortSignal;
        }
    ): Promise<Result | void>;
    cleanup(): Promise<void>;
}
