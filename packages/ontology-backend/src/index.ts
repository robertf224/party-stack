import { Context, Schema } from "effect";
import type { AttachmentTypeDef } from "@party-stack/ontology-spec";
import type { attachment, Encrypted } from "@party-stack/ontology-spec/values";
import type { Key, Query, Row } from "@party-stack/ontology-storage";
import type { Effect, Stream } from "effect";

export {
    schemaValidationIssues,
    BackendError,
    BackendErrorKindSchema,
    ValidationIssueSchema,
    ValidationReportSchema,
    unauthenticated,
    isUnauthenticatedError,
    classifyBackendFailure,
    projectBackendError,
    projectValidationIssue,
    isUnknownInvocationOutcome,
} from "./errors.js";
export type {
    BackendErrorKind,
    ErrorProjection,
    ErrorProjectionContext,
    ValidationReport,
    ValidationIssue,
    UnauthenticatedError,
    ApplyActionError,
    ValidateActionError,
    LoadSubsetError,
} from "./errors.js";
import { BackendError } from "./errors.js";

export interface BackendSubset {
    readonly objectType: string;
    readonly query?: Query;
}
export interface BackendSnapshot {
    readonly rows: readonly Row<Record<string, unknown>>[];
    /** Complete for the requested query, including its limit/cursor, not for the whole object type. */
    readonly complete: boolean;
    /** Rows fetched from the provider, before adapter-side filtering/windowing.
     * Diagnostic only; omitted when the adapter cannot report it. Not a DB scan count.
     */
    readonly fetchedRows?: number;
    /** Diagnostic provider filter, not a query-capability or coverage contract. */
    readonly pushdown?: SourceQueryPlan;
    /** Position coordinated with this snapshot, when the backend exposes a durable change stream. */
    readonly cursor?: string;
}
export const SourceQueryPlanSchema = Schema.Struct({
    source: Schema.String,
    /** Paths into the request's portable where tree: AND/OR child indices, NOT child 0, [] for the root. */
    predicates: Schema.Array(
        Schema.Struct({
            path: Schema.Array(Schema.Int),
            execution: Schema.Literals(["source", "candidate", "adapter"]),
        })
    ),
    sorting: Schema.Literals(["source", "adapter", "none"]),
    pagination: Schema.Literals(["source", "adapter", "none"]),
    rechecksFilter: Schema.Boolean,
    /** Optional native syntax for raw inspection. Consumers must not parse it to infer execution. */
    native: Schema.optional(Schema.Struct({ language: Schema.String, text: Schema.String })),
});
export type SourceQueryPlan = Schema.Schema.Type<typeof SourceQueryPlanSchema>;
export type ObjectChange =
    | {
          readonly kind: "put";
          readonly objectType: string;
          readonly key: Key;
          readonly value: Record<string, unknown>;
      }
    | { readonly kind: "delete"; readonly objectType: string; readonly key: Key };
export interface BackendCommit {
    readonly cursor: string;
    readonly changes: readonly ObjectChange[];
    readonly invocationId?: string;
}
export interface BackendChangePage {
    readonly commits: readonly BackendCommit[];
    readonly cursor: string;
    readonly hasMore: boolean;
}
export interface AttachmentUpload {
    readonly attachment: attachment;
    readonly blob: Blob;
    readonly target?: AttachmentTypeDef;
}
export interface ActionInvocation {
    /** Stable across retries. The source must separately guarantee keyed idempotency. */
    readonly id: string;
    readonly name: string;
    readonly parameters: Record<string, unknown>;
    readonly attachmentUploads?: readonly AttachmentUpload[];
    /** Portable replay inputs, preserved across rebases, forwarding and authoritative execution. */
    readonly replay?: { readonly now: string; readonly seed: string };
}
export interface ActionReceipt {
    readonly invocationId: string;
    /** Accepted remote actions may still require read-back before optimistic state can settle. */
    readonly outcome: "committed" | "accepted";
    readonly cursor?: string;
    readonly operationId?: string;
    /** Read-back targets for a committed non-journal action. Missing keys
     * means the whole type; an empty list means no modeled object changes.
     * Omission conservatively refreshes every modeled type.
     * Targets are complete unless affectedComplete is explicitly false.
     */
    readonly affected?: readonly {
        readonly objectType: string;
        readonly keys?: readonly Key[];
    }[];
    /** False when these are known targets but automation may have changed other
     * modeled records. Confirmation must not use them as an exhaustive edit list.
     */
    readonly affectedComplete?: boolean;
    readonly attachmentIdMappings?: readonly { readonly localId: string; readonly remoteId: string }[];
}
const KeySchema = Schema.Union([Schema.String, Schema.Finite]);
export const ObjectChangeSchema = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("put"),
        objectType: Schema.String,
        key: KeySchema,
        value: Schema.Record(Schema.String, Schema.Unknown),
    }),
    Schema.Struct({ kind: Schema.Literal("delete"), objectType: Schema.String, key: KeySchema }),
]);
export const ActionReceiptSchema = Schema.Struct({
    invocationId: Schema.String,
    outcome: Schema.Literals(["committed", "accepted"]),
    cursor: Schema.optional(Schema.String),
    operationId: Schema.optional(Schema.String),
    affected: Schema.optional(
        Schema.Array(
            Schema.Struct({ objectType: Schema.String, keys: Schema.optional(Schema.Array(KeySchema)) })
        )
    ),
    affectedComplete: Schema.optional(Schema.Boolean),
    attachmentIdMappings: Schema.optional(
        Schema.Array(Schema.Struct({ localId: Schema.String, remoteId: Schema.String }))
    ),
});
export const BackendCommitSchema = Schema.Struct({
    cursor: Schema.String,
    changes: Schema.Array(ObjectChangeSchema),
    invocationId: Schema.optional(Schema.String),
});
export const BackendSnapshotSchema = Schema.Struct({
    fetchedRows: Schema.optional(Schema.Number),
    pushdown: Schema.optional(SourceQueryPlanSchema),
    rows: Schema.Array(
        Schema.Struct({ key: KeySchema, value: Schema.Record(Schema.String, Schema.Unknown) })
    ),
    complete: Schema.Boolean,
    cursor: Schema.optional(Schema.String),
});
export const BackendChangePageSchema = Schema.Struct({
    commits: Schema.Array(BackendCommitSchema),
    cursor: Schema.String,
    hasMore: Schema.Boolean,
});

export interface BackendAttachments {
    /** Optional authoritative staging before a subsequent action references the handle. */
    readonly stage?: (value: attachment, bytes: Blob) => Effect.Effect<attachment, BackendError>;
    readonly read: (
        value: attachment,
        options?: { readonly offset?: number; readonly length?: number }
    ) => Effect.Effect<Blob, BackendError>;
    readonly metadata: (
        value: attachment
    ) => Effect.Effect<
        { readonly size: number; readonly type: string; readonly name?: string },
        BackendError
    >;
}
export { EncryptedValueSchema, DecryptedValueSchema, encryptedPropertyCodec } from "./encrypted.js";
export type { DecryptedValue } from "./encrypted.js";

export interface BackendEncryptedValues {
    /** Explicit operation. Ordinary record loads return handles and never invoke this method. */
    readonly decrypt: (
        value: Encrypted<unknown>
    ) => Effect.Effect<import("./encrypted.js").DecryptedValue, BackendError>;
}
export interface OntologyBackendService {
    readonly name: string;
    /** Stable identity for the source whose cursors and receipts this binding returns. */
    readonly sourceId: string;
    /** Durable keyed idempotency: repeated IDs return the recorded result, with
     * conflicting payloads rejected. The guarantee must survive source restart.
     * Merely receiving an ID, or an action being naturally idempotent, is insufficient.
     */
    readonly supportsIdempotency: boolean;
    /** Indexed bounded local maintenance; an enclosing server scope schedules it. */
    readonly maintenance?: Effect.Effect<void, BackendError>;
    readonly loadSubset: (subset: BackendSubset) => Effect.Effect<BackendSnapshot, BackendError>;
    /** Demand-scoped invalidation hints, independent of a durable journal. Undefined
     * means this subset needs polling. Reconnect must invalidate to repair missed events.
     */
    readonly watchSubset?: (subset: BackendSubset) => Stream.Stream<void, BackendError> | undefined;
    /** Demand-scoped polling when watchSubset is unavailable. Must be at least 100 ms.
     * Without an override, unwatched subsets refresh on the Replica's sync polling interval.
     * False keeps the installed snapshot until explicit invalidation or new demand.
     */
    readonly pollIntervalMs?: (subset: BackendSubset) => number | false | undefined;
    readonly validateAction?: (
        name: string,
        parameters: Record<string, unknown>,
        options?: { readonly knownParameters?: readonly string[] }
    ) => Effect.Effect<import("./errors.js").ValidationReport, BackendError>;
    readonly invoke: (invocation: ActionInvocation) => Effect.Effect<ActionReceipt, BackendError>;
    readonly queryFunction: (
        name: string,
        parameters: Record<string, unknown>
    ) => Effect.Effect<unknown, BackendError>;
    readonly changes?: {
        readonly pull: (options: {
            readonly cursor?: string;
            readonly limit?: number;
        }) => Effect.Effect<BackendChangePage, BackendError>;
        /** Wake-up hints only. Call pull to recover durable changes after reconnect or restart. */
        readonly watch?: Stream.Stream<void, BackendError>;
    };
    readonly attachments?: BackendAttachments;
    readonly encrypted?: BackendEncryptedValues;
}

/** Backend protocol independent of TanStack collections and client lifecycle management. */
export class OntologyBackend extends Context.Service<OntologyBackend, OntologyBackendService>()(
    "@party-stack/ontology-backend/OntologyBackend"
) {}
