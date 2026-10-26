import { and, eq, field, lte } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Clock, Effect, Schema } from "effect";
import { BackendError } from "./index.js";
import type { ClientView } from "./protocol.js";
import type { OntologyStorageError } from "@party-stack/ontology-storage";
import type { Transaction } from "@party-stack/ontology-storage/tables";

const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const ClientTokenSchema = Schema.Struct({
    sourceId: Schema.NonEmptyString,
    clientId: Schema.NonEmptyString,
    resumeKey: Schema.NonEmptyString,
});
export type ClientToken = typeof ClientTokenSchema.Type;
export const ClientSessionSchema = Schema.Struct({
    client: ClientTokenSchema,
    connectionId: Schema.NonEmptyString,
});
export type ClientSession = typeof ClientSessionSchema.Type;
const ClientRecordSchema = Schema.Struct({
    ...ClientSessionSchema.fields,
    expiresAt: Schema.Finite,
    acceptedThrough: Counter,
    acknowledgedThrough: Counter,
    deliveredThrough: Counter,
    deliveredRevision: Counter,
    appliedRevision: Counter,
    viewGeneration: Schema.optional(Counter),
    viewIdentity: Schema.optional(Schema.String),
    deliveredViewGeneration: Schema.optional(Counter),
});
export const ClientLeaseSchema = ClientRecordSchema;
export type ClientLease = typeof ClientRecordSchema.Type;
export interface ClientPolicy {
    readonly leaseMs?: number;
    readonly maxClients?: number;
    readonly maxUnacknowledged?: number;
}
export interface ClientRegistryHooks {
    /** Release only this client's retained delivery/results, never accepted work. */
    readonly onExpire?: (
        tx: Transaction,
        clientId: string
    ) => Effect.Effect<void, BackendError | OntologyStorageError>;
}
const error = (operation: string, kind: BackendError["kind"], message: string) =>
    new BackendError({
        operation: `replica.client.${operation}`,
        kind,
        message,
        retryable: kind === "Unavailable" || kind === "RateLimited",
    });

/** Transaction-local admission bookkeeping. The caller must use the SAME tx for
 * admit's callback and source state. Neither reconnect nor expiration executes actions.
 */
export const clientRegistry = (
    namespace: string,
    sourceId: string,
    policy: ClientPolicy = {},
    hooks: ClientRegistryHooks = {}
) => {
    const leaseMs = policy.leaseMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxClients = policy.maxClients ?? 256;
    const maxUnacknowledged = policy.maxUnacknowledged ?? 1024;
    const clients = Table.make({
        name: JSON.stringify(["replica", namespace, "clients"]),
        codec: {
            encode: Schema.encodeSync(ClientRecordSchema),
            decode: Schema.decodeUnknownSync(ClientRecordSchema),
        },
    });
    const submissions = Table.make<{ clientId: string; sequence: number; fingerprint: string }>({
        name: JSON.stringify(["replica", namespace, "submissions"]),
    });
    const validatePolicy = Effect.gen(function* () {
        if (
            !Number.isFinite(leaseMs) ||
            leaseMs < 1 ||
            !Number.isSafeInteger(maxClients) ||
            maxClients < 1 ||
            !Number.isSafeInteger(maxUnacknowledged) ||
            maxUnacknowledged < 1
        )
            return yield* error("policy", "ValidationFailed", "Client retention bounds must be positive.");
    });
    const initialize = (tx: Transaction) =>
        Effect.gen(function* () {
            yield* validatePolicy;
            yield* tx.ensureIndex(clients, { name: "expiresAt", field: field("expiresAt") });
            yield* tx.ensureIndex(submissions, { name: "clientId", field: field("clientId") });
        });
    const validate = Effect.fnUntraced(function* (tx: Transaction, session: ClientSession) {
        const now = yield* Clock.currentTimeMillis;
        const stored = yield* tx.get(clients, session.client.clientId);
        if (session.client.sourceId !== sourceId || (stored && stored.client.sourceId !== sourceId))
            return yield* error("source", "SourceMismatch", "Client session belongs to a different source.");
        if (!stored || stored.expiresAt <= now)
            return yield* error(
                "expired",
                "SessionExpired",
                "Client session expired. Open a new client while preserving unresolved work."
            );
        if (
            stored.client.resumeKey !== session.client.resumeKey ||
            stored.connectionId !== session.connectionId
        )
            return yield* error(
                "replaced",
                "SessionReplaced",
                "A newer connection replaced this client session."
            );
        return { ...stored, expiresAt: now + leaseMs };
    });
    const expire = Effect.fnUntraced(function* (tx: Transaction, limit = 100) {
        const now = yield* Clock.currentTimeMillis;
        const expired = yield* tx.loadSubset(clients, { where: lte(field("expiresAt"), now), limit });
        for (const { key, value } of expired) {
            if (hooks.onExpire) yield* hooks.onExpire(tx, value.client.clientId);
            for (const row of yield* tx.loadSubset(submissions, {
                where: eq(field("clientId"), value.client.clientId),
            }))
                yield* tx.delete(submissions, row.key);
            yield* tx.delete(clients, key);
        }
        return expired.map((row) => row.value.client.clientId);
    });
    const open = Effect.fn("Replica.openClient")(function* (tx: Transaction, resume?: ClientToken) {
        const now = yield* Clock.currentTimeMillis;
        let previous: ClientLease | undefined;
        if (resume) {
            previous = yield* tx.get(clients, resume.clientId);
            if (
                !previous ||
                resume.sourceId !== sourceId ||
                previous.client.sourceId !== sourceId ||
                previous.client.resumeKey !== resume.resumeKey ||
                previous.expiresAt <= now
            )
                return yield* error(
                    "expired",
                    "SessionExpired",
                    "Client identity cannot be resumed. Preserve unresolved local work and open a new client explicitly."
                );
        } else {
            yield* expire(tx);
            if ((yield* tx.loadSubset(clients, { limit: maxClients })).length >= maxClients)
                return yield* error("capacity", "RateLimited", "Active client limit reached.");
        }
        const record: ClientLease = {
            client: previous?.client ?? {
                sourceId,
                clientId: crypto.randomUUID(),
                resumeKey: crypto.randomUUID(),
            },
            connectionId: crypto.randomUUID(),
            expiresAt: now + leaseMs,
            acceptedThrough: previous?.acceptedThrough ?? 0,
            acknowledgedThrough: previous?.acknowledgedThrough ?? 0,
            deliveredThrough: previous?.deliveredThrough ?? 0,
            deliveredRevision: previous?.deliveredRevision ?? 0,
            appliedRevision: previous?.appliedRevision ?? 0,
            viewGeneration: previous?.viewGeneration ?? 0,
            viewIdentity: previous?.viewIdentity,
            deliveredViewGeneration: previous?.deliveredViewGeneration ?? 0,
        };
        yield* tx.put(clients, record.client.clientId, record);
        return record;
    });
    const admit = Effect.fn("Replica.admitClientAction")(function* <A, E>(
        tx: Transaction,
        session: ClientSession,
        sequence: number,
        fingerprint: string,
        accept: () => Effect.Effect<A, E>
    ) {
        const record = yield* validate(tx, session);
        if (!Number.isSafeInteger(sequence) || sequence < 1)
            return yield* error(
                "sequence",
                "ValidationFailed",
                "Submission sequence must be a positive safe integer."
            );
        if (sequence <= record.acceptedThrough) {
            const prior = yield* tx.get(submissions, JSON.stringify([record.client.clientId, sequence]));
            if (!prior)
                return yield* error(
                    "resultExpired",
                    "ResultExpired",
                    "Submission was already accepted and its acknowledgment record was compacted. It must not execute again."
                );
            if (prior.fingerprint !== fingerprint)
                return yield* error(
                    "identity",
                    "Conflict",
                    "Submission sequence was reused for a different action."
                );
            yield* tx.put(clients, record.client.clientId, record);
            return { duplicate: true as const };
        }
        if (sequence !== record.acceptedThrough + 1)
            return yield* error(
                "sequence",
                "Conflict",
                "Submission is out of order; a preceding action is missing."
            );
        if (record.acceptedThrough - record.acknowledgedThrough >= maxUnacknowledged)
            return yield* error(
                "capacity",
                "RateLimited",
                "Unacknowledged submission limit reached; apply and acknowledge source state first."
            );
        const value = yield* accept();
        yield* tx.put(submissions, JSON.stringify([record.client.clientId, sequence]), {
            clientId: record.client.clientId,
            sequence,
            fingerprint,
        });
        yield* tx.put(clients, record.client.clientId, { ...record, acceptedThrough: sequence });
        return { duplicate: false as const, value };
    });
    const select = Effect.fnUntraced(function* (tx: Transaction, session: ClientSession, view?: ClientView) {
        const record = yield* validate(tx, session);
        const generation = view?.generation ?? 0;
        if (!Number.isSafeInteger(generation) || generation < (view ? 1 : 0))
            return yield* error(
                "view",
                "ValidationFailed",
                "A selected view requires a positive safe generation."
            );
        const identity = view ? Table.make({ name: "view-identity" }).encode(view.selection) : "all";
        if (generation < (record.viewGeneration ?? 0))
            return yield* error("view", "ViewReplaced", "A newer selected view replaced this request.");
        if (
            generation === (record.viewGeneration ?? 0) &&
            record.viewIdentity !== undefined &&
            identity !== record.viewIdentity
        )
            return yield* error("view", "Conflict", "A view generation was reused for different membership.");
        const updated = { ...record, viewGeneration: generation, viewIdentity: identity };
        yield* tx.put(clients, record.client.clientId, updated);
        return updated;
    });
    const deliver = Effect.fnUntraced(function* (tx: Transaction, session: ClientSession, revision: number) {
        const record = yield* validate(tx, session);
        if (!Number.isSafeInteger(revision) || revision < record.deliveredRevision)
            return yield* error("delivery", "Conflict", "Source delivery revision moved backwards.");
        const updated = {
            ...record,
            deliveredRevision: revision,
            deliveredThrough: record.acceptedThrough,
            deliveredViewGeneration: record.viewGeneration ?? 0,
        };
        yield* tx.put(clients, record.client.clientId, updated);
        return updated;
    });
    const acknowledge = Effect.fn("Replica.acknowledgeClient")(function* (
        tx: Transaction,
        session: ClientSession,
        revision: number,
        through: number,
        viewGeneration = 0
    ) {
        const record = yield* validate(tx, session);
        if (
            viewGeneration !== (record.viewGeneration ?? 0) ||
            viewGeneration !== (record.deliveredViewGeneration ?? 0)
        )
            return yield* error(
                "view",
                "ViewReplaced",
                "This acknowledgment belongs to a replaced or undelivered view."
            );
        if (
            !Number.isSafeInteger(revision) ||
            revision < 0 ||
            revision > record.deliveredRevision ||
            !Number.isSafeInteger(through) ||
            through < 0 ||
            through > record.deliveredThrough
        )
            return yield* error(
                "acknowledgment",
                "ValidationFailed",
                "Cannot acknowledge state or submissions that were not delivered."
            );
        // A delayed acknowledgment of an older snapshot cannot prove which newer
        // admissions that snapshot contained. Leave pruning to the current barrier.
        if (revision < record.deliveredRevision || through < record.acknowledgedThrough) return record;
        for (const row of yield* tx.loadSubset(submissions, {
            where: and(eq(field("clientId"), record.client.clientId), lte(field("sequence"), through)),
        }))
            yield* tx.delete(submissions, row.key);
        const updated = { ...record, appliedRevision: revision, acknowledgedThrough: through };
        yield* tx.put(clients, record.client.clientId, updated);
        return updated;
    });
    return { initialize, open, validate, select, admit, deliver, acknowledge, expire, clients, submissions };
};
