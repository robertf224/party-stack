import { QuerySchema } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { ClientLeaseSchema, ClientSessionSchema } from "./clients.js";
import { ActionReceiptSchema, BackendErrorKindSchema, ValidationIssueSchema } from "./index.js";
import type { ClientLease, ClientSession, ClientToken } from "./clients.js";
import type { ActionInvocation, ActionReceipt, BackendError, BackendSubset } from "./index.js";
import type { Row } from "@party-stack/ontology-storage";
import type { Override } from "@party-stack/ontology-storage/overlay";
import type { Scope, Stream } from "effect";

/** Logical action state shared by owned sources, intermediate replicas and clients. */
export interface PendingAction {
    readonly invocation: ActionInvocation;
    readonly requestIdentity: string;
    readonly createdAt: number;
    readonly sequence: number;
    readonly state: "queued" | "sending" | "acknowledged" | "blocked";
    readonly optimistic: boolean;
    readonly attempts: number;
    /** Total attempts at the last explicit retry; automatic retry budgets start here. */
    readonly retryFromAttempt?: number;
    readonly nextAttemptAt?: number;
    readonly failureMessage?: string;
    readonly failureIssues?: readonly import("./errors.js").ValidationIssue[];
    readonly completedAt?: number;
    /** The upstream cannot safely deduplicate another attempt; caller acknowledgment is required. */
    readonly retryRequiresAcknowledgement?: boolean;
    readonly failureOutcome?: "not-committed" | "unknown";
    readonly failureRetryable?: boolean;
    readonly receipt?: ActionReceipt;
    readonly failure?: BackendError["kind"];
    readonly touchedTypes: readonly string[];
    readonly submission?: { readonly clientId: string; readonly sequence: number };
}

/** Consistent logical state. Selected views limit membership, while authorization
 * and property/action projection remain the server's responsibility.
 */
export interface ReplicaStateSnapshot {
    readonly sourceId: string;
    readonly revision: number;
    readonly definition: string;
    readonly view?: { readonly generation: number };
    readonly objects: readonly {
        readonly objectType: string;
        readonly base: readonly Row<Record<string, unknown>>[];
        readonly overrides: readonly Row<Override<Record<string, unknown>>>[];
    }[];
    readonly pending: readonly PendingAction[];
    readonly completed: readonly PendingAction[];
}

/** Membership is evaluated against the source's composed visible state. Action
 * inspection is privileged and must be authorized independently of row access.
 */
export interface StateSelection {
    readonly subsets: readonly BackendSubset[];
    readonly actionIds: readonly string[];
    readonly inspectActions?: boolean;
}
export interface ClientView {
    readonly generation: number;
    readonly selection: StateSelection;
}

export interface ClientState {
    readonly state: ReplicaStateSnapshot;
    readonly client: ClientLease;
}
export interface ClientSubmission {
    readonly session: ClientSession;
    readonly sequence: number;
    readonly invocation: ActionInvocation;
    readonly optimistic: boolean;
    readonly view?: ClientView;
}

/** A protocol source need not contain a Replica or an upstream outbox. Ordered
 * submission idempotency is scoped to a valid resumable client lease. A transport
 * must bind authorization and decode data before exposing this interface.
 */
export interface OntologySource {
    readonly sourceId: string;
    readonly supportsIdempotency: boolean;
    readonly openClient: (resume?: ClientToken) => Effect.Effect<ClientLease, BackendError>;
    readonly read: (session: ClientSession, view?: ClientView) => Effect.Effect<ClientState, BackendError>;
    readonly demand: (subset: BackendSubset) => Effect.Effect<void, BackendError, Scope.Scope>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void, BackendError>, BackendError, Scope.Scope>;
    readonly submit: (request: ClientSubmission) => Effect.Effect<ClientState, BackendError>;
    readonly acknowledge: (
        session: ClientSession,
        revision: number,
        through: number,
        viewGeneration?: number
    ) => Effect.Effect<void, BackendError>;
}

/** Row/action arrays represent keyed records, not their transport ordering. */
export const stateIdentity = (snapshot: ReplicaStateSnapshot): string => {
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const rows = <A>(values: readonly Row<A>[]) =>
        [...values].sort((a, b) => compare(JSON.stringify(a.key), JSON.stringify(b.key)));
    const actions = (values: readonly PendingAction[]) =>
        [...values].sort((a, b) => compare(a.invocation.id, b.invocation.id));
    return Table.make({ name: "state-identity" }).encode({
        ...snapshot,
        objects: [...snapshot.objects]
            .sort((a, b) => compare(a.objectType, b.objectType))
            .map((object) => ({
                ...object,
                base: rows(object.base),
                overrides: rows(object.overrides),
            })),
        pending: actions(snapshot.pending),
        completed: actions(snapshot.completed),
    });
};

const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const PositiveCounter = Counter.check(Schema.isGreaterThan(0));
const KeySchema = Schema.Union([Schema.String, Schema.Finite]);
const ValueSchema = Schema.Record(Schema.String, Schema.Unknown);
export const ActionInvocationSchema = Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    parameters: ValueSchema,
    replay: Schema.optional(Schema.Struct({ now: Schema.String, seed: Schema.NonEmptyString })),
});
export const PendingActionSchema = Schema.Struct({
    invocation: ActionInvocationSchema,
    requestIdentity: Schema.String,
    createdAt: Schema.Finite,
    sequence: PositiveCounter,
    state: Schema.Literals(["queued", "sending", "acknowledged", "blocked"]),
    optimistic: Schema.Boolean,
    attempts: Counter,
    retryFromAttempt: Schema.optional(Counter),
    nextAttemptAt: Schema.optional(Schema.Finite),
    failureMessage: Schema.optional(Schema.String),
    failureIssues: Schema.optional(Schema.Array(ValidationIssueSchema)),
    completedAt: Schema.optional(Schema.Finite),
    retryRequiresAcknowledgement: Schema.optional(Schema.Boolean),
    failureOutcome: Schema.optional(Schema.Literals(["not-committed", "unknown"])),
    failureRetryable: Schema.optional(Schema.Boolean),
    receipt: Schema.optional(ActionReceiptSchema),
    failure: Schema.optional(BackendErrorKindSchema),
    touchedTypes: Schema.Array(Schema.String),
    submission: Schema.optional(
        Schema.Struct({ clientId: Schema.NonEmptyString, sequence: PositiveCounter })
    ),
});
export const BackendSubsetSchema = Schema.Struct({
    objectType: Schema.NonEmptyString,
    query: Schema.optional(QuerySchema),
});
export const ClientViewSchema = Schema.Struct({
    generation: PositiveCounter,
    selection: Schema.Struct({
        subsets: Schema.Array(BackendSubsetSchema),
        actionIds: Schema.Array(Schema.NonEmptyString),
        inspectActions: Schema.optional(Schema.Boolean),
    }),
});
export const ReplicaStateSnapshotSchema = Schema.Struct({
    sourceId: Schema.NonEmptyString,
    revision: PositiveCounter,
    definition: Schema.NonEmptyString,
    view: Schema.optional(Schema.Struct({ generation: PositiveCounter })),
    objects: Schema.Array(
        Schema.Struct({
            objectType: Schema.NonEmptyString,
            base: Schema.Array(Schema.Struct({ key: KeySchema, value: ValueSchema })),
            overrides: Schema.Array(
                Schema.Struct({
                    key: KeySchema,
                    value: Schema.Union([
                        Schema.Struct({ deleted: Schema.Literal(true) }),
                        Schema.Struct({ deleted: Schema.Literal(false), value: ValueSchema }),
                    ]),
                })
            ),
        })
    ),
    pending: Schema.Array(PendingActionSchema),
    completed: Schema.Array(PendingActionSchema),
});
const ClientStateSchema = Schema.Struct({ state: ReplicaStateSnapshotSchema, client: ClientLeaseSchema });
const ClientSubmissionSchema = Schema.Struct({
    session: ClientSessionSchema,
    sequence: PositiveCounter,
    invocation: ActionInvocationSchema,
    optimistic: Schema.Boolean,
    view: Schema.optional(ClientViewSchema),
});

// Reuse the storage value codec for bigint/Temporal/nested values rather than
// letting JSON or structured clone silently change the domain representation.
const values = Table.make<unknown>({ name: "ontology-protocol-value" });
export const protocolValueCodec = <A>(schema: Schema.Codec<A>): Schema.Codec<A, string> =>
    Schema.String.pipe(
        Schema.decodeTo(Schema.Unknown, {
            decode: SchemaGetter.transformEffect((input: string) =>
                Effect.try({
                    try: () => values.decode(input),
                    catch: () =>
                        new SchemaIssue.InvalidValue({ message: "Invalid ontology protocol encoding." }),
                })
            ),
            encode: SchemaGetter.transformEffect((input: unknown) =>
                Effect.try({
                    try: () => values.encode(input),
                    catch: () =>
                        new SchemaIssue.InvalidValue({ message: "Unsupported ontology protocol value." }),
                })
            ),
        }),
        Schema.decodeTo(Schema.toType(schema))
    );
export const ClientStateCodec = protocolValueCodec(ClientStateSchema);
export const ClientSubmissionCodec = protocolValueCodec(ClientSubmissionSchema);
export const ClientViewCodec = protocolValueCodec(ClientViewSchema);
export const BackendSubsetCodec = protocolValueCodec(BackendSubsetSchema);
