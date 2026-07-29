import type { OntologyActionRequest, OntologyOutboxEntry } from "./types.js";

export const OUTBOX_COORDINATION_SERVICE = "party-stack.outbox.v1";

export interface OutboxErrorDetails {
    name: string;
    message: string;
}

export type OutboxResultEvent =
    | {
          type: "completed";
          id: string;
          result: unknown;
      }
    | {
          type: "rejected";
          id: string;
          error: OutboxErrorDetails;
      };

export interface OutboxCoordinationService {
    methods: {
        enqueue(input: { entry: OntologyOutboxEntry }): Promise<OntologyOutboxEntry>;
        edit(input: { id: string; request: OntologyActionRequest }): Promise<OntologyOutboxEntry>;
        remove(input: { id: string }): Promise<void>;
        retry(input: { id: string }): Promise<void>;
        recover(input: {
            failureStrategy:
                | "pause"
                | "discard-all";
            maxRetries: number;
        }): Promise<void>;
        claim(input: Record<string, never>): Promise<OntologyOutboxEntry | undefined>;
        nextRetryAt(
            input: Record<string, never>
        ): Promise<number | undefined>;
        complete(input: { id: string; executionId: string; result: unknown }): Promise<void>;
        fail(input: {
            id: string;
            executionId: string;
            retryable: boolean;
            retryAt?: number;
            error: OutboxErrorDetails;
        }): Promise<OntologyOutboxEntry>;
        discardAll(input: {
            id: string;
            executionId: string;
            error: OutboxErrorDetails;
        }): Promise<void>;
    };
    events: {
        result: OutboxResultEvent;
    };
}
