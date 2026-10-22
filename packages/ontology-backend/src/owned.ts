import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import {
    makeOntologyStorage,
    makeStorageModel,
    and,
    eq,
    field,
    lte,
    indexesForQuery,
} from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Clock, Effect, PubSub, Schema, Stream } from "effect";
import { clientRegistry } from "./clients.js";
import { BackendError, ActionReceiptSchema, BackendCommitSchema } from "./index.js";
import type { ClientPolicy } from "./clients.js";
import type {
    ActionInvocation,
    ActionReceipt,
    BackendCommit,
    ObjectChange,
    OntologyBackendService,
} from "./index.js";
import type { ClientSubmission, OntologySource, PendingAction } from "./protocol.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Key, Query, ReadStorageTransaction, StorageTransaction } from "@party-stack/ontology-storage";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export interface OwnedReadTransaction {
    get(objectType: string, key: Key): Effect.Effect<Record<string, unknown> | undefined, BackendError>;
    loadSubset(
        objectType: string,
        query?: Query
    ): Effect.Effect<readonly { readonly key: Key; readonly value: Record<string, unknown> }[], BackendError>;
}
export interface OwnedTransaction extends OwnedReadTransaction {
    put(objectType: string, value: Record<string, unknown>): Effect.Effect<void, BackendError>;
    delete(objectType: string, key: Key): Effect.Effect<void, BackendError>;
}
export interface OwnedBackendOptions {
    readonly namespace: string;
    readonly ir: OntologyIR;
    readonly tables: TablesService;
    readonly blobs?: import("@party-stack/ontology-storage/blobs").BlobStorageService;
    /** A trusted principal binding; invocation IDs are deduplicated within this authority scope. */
    readonly invocationScope?: string;
    readonly clients?: ClientPolicy;
    /** Bounded replay history. Cursors behind this floor require a fresh snapshot. */
    readonly history?: { readonly maxCommits?: number };
    readonly mutators: Readonly<
        Record<
            string,
            (tx: OwnedTransaction, invocation: ActionInvocation) => Effect.Effect<void, BackendError>
        >
    >;
    readonly queryFunctions?: Readonly<
        Record<
            string,
            (
                tx: OwnedReadTransaction,
                parameters: Record<string, unknown>
            ) => Effect.Effect<unknown, BackendError>
        >
    >;
    readonly attachments?: OntologyBackendService["attachments"];
    readonly encrypted?: OntologyBackendService["encrypted"];
    /** Stage external bytes before opening the object transaction; returned metadata work joins its commit. */
    readonly prepareUploads?: (
        invocation: ActionInvocation
    ) => Effect.Effect<Effect.Effect<void, BackendError>, BackendError>;
}
export interface OwnedBackendService extends OntologyBackendService {
    /** Trusted protocol composition without an intermediate Replica or outbox. */
    readonly protocol: OntologySource;
    readonly collectClientGarbage: Effect.Effect<number, BackendError>;
}
const fault = (operation: string, kind: BackendError["kind"], message: string, cause?: unknown) =>
    new BackendError({ operation, kind, message, retryable: false, cause });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
        Effect.mapError((error) =>
            error instanceof BackendError
                ? error
                : fault("storage", "Unavailable", "Owned storage operation failed.", error)
        )
    );
const CursorSchema = Schema.Struct({ source: Schema.String, revision: Schema.Int });
const ReceiptSchema = Schema.Struct({ fingerprint: Schema.String, receipt: ActionReceiptSchema });
const JournalSchema = Schema.Struct({ revision: Schema.Int, commit: BackendCommitSchema });
const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, stableValue(entry)])
        );
    return value;
};

/** Authoritative local backend with atomic mutation batches, durable receipts, and a pull journal. */
export const makeOwnedBackend = Effect.fnUntraced(function* (
    options: OwnedBackendOptions
): Effect.fn.Return<OwnedBackendService, BackendError> {
    const schemas = yield* Effect.try({
        try: () => compileEffectSchemas(options.ir),
        catch: (cause) => fault("definition", "Rejected", "Invalid ontology definition.", cause),
    });
    // Backend protocols carry portable ontology values; Effect-facing clients may decode them at their boundary.
    const objectSchemas = Object.fromEntries(
        Object.entries(schemas.objectSchemas).map(([name, schema]) => [name, Schema.toEncoded(schema)])
    );
    const model = yield* boundary(
        makeStorageModel({ namespace: options.namespace, ir: options.ir, schemas: objectSchemas })
    );
    const storage = makeOntologyStorage(model, options.tables, { blobs: options.blobs });
    const tables = options.tables;
    const maxCommits = options.history?.maxCommits ?? 10_000;
    if (!Number.isSafeInteger(maxCommits) || maxCommits < 1)
        return yield* fault("history", "Rejected", "Journal retention requires a positive commit bound.");
    const receiptKey = (id: string) => JSON.stringify([options.invocationScope ?? "system", id]);
    const metadata = Table.make<{ revision: number; source: string; journalFloor?: number }>({
        name: JSON.stringify(["backend", options.namespace, "metadata"]),
    });
    const receipts = Table.make<{ fingerprint: string; receipt: ActionReceipt }>({
        name: JSON.stringify(["backend", options.namespace, "receipts"]),
        codec: {
            encode: (value) => Schema.encodeSync(ReceiptSchema)(value),
            decode: (value) =>
                Schema.decodeUnknownSync(ReceiptSchema)(value) as {
                    fingerprint: string;
                    receipt: ActionReceipt;
                },
        },
    });
    const journal = Table.make<{ revision: number; commit: BackendCommit }>({
        name: JSON.stringify(["backend", options.namespace, "journal"]),
        codec: {
            encode: (value) => Schema.encodeSync(JournalSchema)(value),
            decode: (value) =>
                Schema.decodeUnknownSync(JournalSchema)(value) as { revision: number; commit: BackendCommit },
        },
    });
    let source = "";
    const cursor = (revision: number) => JSON.stringify({ source, revision });
    const parseCursor = (encoded: string | undefined, current: number) =>
        Effect.try({
            try: () => {
                if (encoded === undefined) return 0;
                const parsed = Schema.decodeUnknownSync(CursorSchema)(JSON.parse(encoded));
                if (
                    parsed.source !== source ||
                    !Number.isSafeInteger(parsed.revision) ||
                    parsed.revision < 0 ||
                    parsed.revision > current
                )
                    throw new TypeError("Cursor does not belong to this source history.");
                return parsed.revision;
            },
            catch: () => fault("changes", "InvalidCursor", "Invalid backend change cursor."),
        });
    const current = Effect.map(tables.get(metadata, "head"), (value) => value?.revision ?? 0);
    const wakes = yield* PubSub.sliding<void>(1);
    yield* boundary(
        storage.transaction((native) =>
            Effect.gen(function* () {
                yield* tables.ensureIndex(journal, {
                    name: "revision",
                    field: { _tag: "Field", path: ["revision"] },
                    unique: true,
                });
                for (const object of Object.values(model.objects))
                    yield* native.ensureIndex(object, {
                        name: "primaryKey",
                        field: { _tag: "Field", path: [object.definition.primaryKey] },
                        unique: true,
                    });
                const head = yield* tables.get(metadata, "head");
                source = head?.source ?? `${options.namespace}:${crypto.randomUUID()}`;
                if (!head) yield* tables.put(metadata, "head", { source, revision: 0 });
            })
        )
    );
    const object = (name: string) => {
        const store = model.objects[name];
        return store
            ? Effect.succeed(store)
            : Effect.fail(fault("object", "Rejected", `Unknown object type ${JSON.stringify(name)}.`));
    };
    const read = (native: ReadStorageTransaction): OwnedReadTransaction => ({
        get: (name, key) => boundary(Effect.flatMap(object(name), (store) => native.get(store, key))),
        loadSubset: (name, query) =>
            boundary(Effect.flatMap(object(name), (store) => native.loadSubset(store, query))),
    });
    const prepare = Effect.fn("OwnedBackend.prepare")(function* (invocation: ActionInvocation) {
        const parameterSchema = schemas.actionParameterSchemas[invocation.name];
        if (!parameterSchema || !options.mutators[invocation.name])
            return yield* fault(
                "invoke",
                "Unsupported",
                `No action implementation for ${JSON.stringify(invocation.name)}.`
            );
        if (!invocation.id)
            return yield* fault("invoke", "Rejected", "Actions require a stable invocation ID.");
        const encodedParameters = yield* Schema.encodeEffect(
            Schema.toCodecJson(Schema.toEncoded(parameterSchema))
        )(invocation.parameters).pipe(
            Effect.mapError(() =>
                fault("invoke", "Rejected", "Action parameters do not match their definition.")
            )
        );
        const attachmentIdentity = yield* Effect.tryPromise({
            try: async () =>
                Promise.all(
                    (invocation.attachmentUploads ?? []).map(async (upload) => ({
                        id: upload.attachment.id,
                        target: upload.target,
                        type: upload.blob.type,
                        size: upload.blob.size,
                        digest: Array.from(
                            new Uint8Array(
                                await crypto.subtle.digest("SHA-256", await upload.blob.arrayBuffer())
                            ),
                            (byte) => byte.toString(16).padStart(2, "0")
                        ).join(""),
                    }))
                ),
            catch: (cause) => fault("upload", "Rejected", "Cannot identify attachment bytes.", cause),
        });
        // A preflight avoids staging duplicate uploads on ordinary receipt retries. The
        // write transaction below rechecks identity to resolve concurrent invocations.
        const identity = JSON.stringify(
            stableValue([invocation.name, encodedParameters, attachmentIdentity, invocation.replay])
        );
        return { invocation, identity };
    });
    const invokeIn = Effect.fnUntraced(function* (
        native: StorageTransaction,
        prepared: { invocation: ActionInvocation; identity: string },
        commitUploads: Effect.Effect<void, BackendError>,
        retainReceipt: boolean
    ) {
        const { invocation } = prepared;
        const action = options.ir.actionTypes.find((candidate) => candidate.name === invocation.name);
        const mutator = options.mutators[invocation.name];
        if (!action || !mutator)
            return yield* fault(
                "invoke",
                "Unsupported",
                `No action implementation for ${JSON.stringify(invocation.name)}.`
            );
        if (!invocation.id)
            return yield* fault("invoke", "Rejected", "Actions require a stable invocation ID.");
        const parameters = yield* Schema.decodeUnknownEffect(
            Schema.toEncoded(schemas.actionParameterSchemas[invocation.name]!)
        )(invocation.parameters).pipe(
            Effect.mapError(() =>
                fault("invoke", "Rejected", "Action parameters do not match their definition.")
            )
        );
        const fingerprint = prepared.identity;
        const previous = retainReceipt ? yield* tables.get(receipts, receiptKey(invocation.id)) : undefined;
        if (previous) {
            if (previous.fingerprint !== fingerprint)
                return yield* fault(
                    "invoke",
                    "Conflict",
                    "An invocation ID was reused with different parameters."
                );
            return { receipt: previous.receipt, changed: false };
        }
        const changes = new Map<string, ObjectChange>();
        const tx: OwnedTransaction = {
            ...read(native),
            put: (name, value) =>
                boundary(
                    Effect.gen(function* () {
                        const store = yield* object(name);
                        yield* native.put(store, value);
                        const key = value[store.definition.primaryKey] as Key;
                        changes.set(JSON.stringify([name, key]), {
                            kind: "put",
                            objectType: name,
                            key,
                            value: (yield* native.get(store, key))!,
                        });
                    })
                ),
            delete: (name, key) =>
                boundary(
                    Effect.gen(function* () {
                        const store = yield* object(name);
                        yield* native.delete(store, key);
                        changes.set(JSON.stringify([name, key]), {
                            kind: "delete",
                            objectType: name,
                            key,
                        });
                    })
                ),
        };
        yield* mutator(tx, { ...invocation, parameters });
        yield* commitUploads;
        const revision = (yield* current) + 1;
        if (!Number.isSafeInteger(revision))
            return yield* fault("invoke", "Unavailable", "Backend journal revision exhausted.");
        const receipt: ActionReceipt = {
            invocationId: invocation.id,
            outcome: "committed",
            cursor: cursor(revision),
        };
        const commit: BackendCommit = {
            cursor: receipt.cursor!,
            invocationId: invocation.id,
            changes: [...changes.values()],
        };
        yield* tables.put(journal, revision, { revision, commit });
        if (retainReceipt) yield* tables.put(receipts, receiptKey(invocation.id), { fingerprint, receipt });
        const journalFloor = Math.max(
            (yield* tables.get(metadata, "head"))?.journalFloor ?? 0,
            revision - maxCommits
        );
        for (const row of yield* tables.loadSubset(journal, { where: lte(field("revision"), journalFloor) }))
            yield* tables.delete(journal, row.key);
        yield* tables.put(metadata, "head", { revision, source, journalFloor });
        return {
            receipt,
            changed: true,
            touchedTypes: [...new Set([...changes.values()].map((change) => change.objectType))],
        };
    });
    const clientNamespace = JSON.stringify(["owned", options.namespace, options.invocationScope ?? "system"]);
    const results = Table.make<{ clientId: string; sequence: number; entry: PendingAction }>({
        name: JSON.stringify(["backend", clientNamespace, "client-results"]),
    });
    const control = Table.make<{ revision: number }>({
        name: JSON.stringify(["backend", clientNamespace, "protocol-head"]),
    });
    const bumpControl = Effect.gen(function* () {
        const revision = ((yield* tables.get(control, "head"))?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision))
            return yield* fault("protocol", "Unavailable", "Protocol revision exhausted.");
        yield* tables.put(control, "head", { revision });
    });
    const clients = clientRegistry(clientNamespace, source, options.clients, {
        onExpire: Effect.fnUntraced(function* (tx, clientId) {
            const expired = yield* tx.loadSubset(results, { where: eq(field("clientId"), clientId) });
            for (const row of expired) yield* tx.delete(results, row.key);
            if (expired.length) yield* bumpControl;
        }),
    });
    yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* clients.initialize(tx);
                yield* tx.ensureIndex(results, { name: "clientId", field: field("clientId") });
                yield* tx.ensureIndex(results, {
                    name: "invocationId",
                    field: field("entry", "invocation", "id"),
                });
            })
        )
    );
    const collectClientGarbage = boundary(tables.transaction((tx) => clients.expire(tx))).pipe(
        Effect.tap((expired) => (expired.length ? PubSub.publish(wakes, undefined) : Effect.void)),
        Effect.map((expired) => expired.length)
    );
    const protocol: OntologySource = {
        sourceId: source,
        supportsIdempotency: true,
        openClient: (resume) => boundary(tables.transaction((tx) => clients.open(tx, resume))),
        demand: (subset) =>
            boundary(
                storage.read((native) =>
                    read(native).loadSubset(subset.objectType, { ...subset.query, limit: 0 })
                )
            ).pipe(Effect.asVoid),
        subscribeChanges: PubSub.subscribe(wakes).pipe(Effect.map(Stream.fromSubscription)),
        read: (session, view) =>
            boundary(
                storage.transaction((native) =>
                    Effect.gen(function* () {
                        yield* clients.select(tables, session, view);
                        for (const subset of view?.selection.subsets ?? []) yield* object(subset.objectType);
                        const revision =
                            (yield* current) + ((yield* tables.get(control, "head"))?.revision ?? 0) + 1;
                        if (!Number.isSafeInteger(revision))
                            return yield* fault("protocol", "Unavailable", "Protocol revision exhausted.");
                        const objects = [];
                        for (const [objectType, store] of Object.entries(model.objects)) {
                            const rows = new Map<Key, { key: Key; value: Record<string, unknown> }>();
                            const subsets = view
                                ? view.selection.subsets.filter((subset) => subset.objectType === objectType)
                                : [{ objectType, query: undefined }];
                            for (const subset of subsets)
                                for (const row of yield* native.loadSubset(store, subset.query))
                                    rows.set(row.key, row);
                            objects.push({ objectType, base: [...rows.values()], overrides: [] });
                        }
                        const selectedResults = new Map<string, PendingAction>();
                        if (!view || view.selection.inspectActions)
                            for (const row of yield* tables.loadSubset(results))
                                selectedResults.set(row.value.entry.invocation.id, row.value.entry);
                        else
                            for (const id of view.selection.actionIds)
                                for (const row of yield* tables.loadSubset(results, {
                                    where: eq(field("entry", "invocation", "id"), id),
                                }))
                                    selectedResults.set(id, row.value.entry);
                        const state = {
                            sourceId: source,
                            revision,
                            definition: JSON.stringify(options.ir),
                            ...(view ? { view: { generation: view.generation } } : {}),
                            objects,
                            pending: [],
                            completed: [...selectedResults.values()],
                        };
                        return { state, client: yield* clients.deliver(tables, session, revision) };
                    })
                )
            ),
        submit: Effect.fn("OwnedBackend.submitClient")(function* (request: ClientSubmission) {
            if (!request.invocation.id || request.invocation.attachmentUploads?.length)
                return yield* fault(
                    "protocol",
                    "Rejected",
                    "Protocol submissions require an invocation ID and staged attachment handles."
                );
            if (
                request.view &&
                !request.view.selection.inspectActions &&
                !request.view.selection.actionIds.includes(request.invocation.id)
            )
                return yield* fault(
                    "protocol",
                    "Rejected",
                    "The submission view must include its action outcome."
                );
            const prepared = yield* prepare(request.invocation);
            const fingerprint = Table.make<unknown>({ name: "submission-identity" }).encode({
                invocation: request.invocation,
                optimistic: request.optimistic,
            });
            const admission = yield* boundary(
                storage.transaction((native) =>
                    Effect.gen(function* () {
                        yield* clients.select(tables, request.session, request.view);
                        for (const subset of request.view?.selection.subsets ?? [])
                            yield* read(native).loadSubset(subset.objectType, { ...subset.query, limit: 0 });
                        return yield* clients.admit(
                            tables,
                            request.session,
                            request.sequence,
                            fingerprint,
                            () =>
                                Effect.gen(function* () {
                                    const committed = yield* invokeIn(native, prepared, Effect.void, false);
                                    const entry: PendingAction = {
                                        invocation: request.invocation,
                                        requestIdentity: Table.make<ActionInvocation>({
                                            name: "identity",
                                        }).encode(request.invocation),
                                        createdAt: yield* Clock.currentTimeMillis,
                                        sequence: request.sequence,
                                        state: "acknowledged",
                                        optimistic: request.optimistic,
                                        attempts: 1,
                                        receipt: committed.receipt,
                                        touchedTypes: committed.touchedTypes ?? [],
                                    };
                                    yield* tables.put(
                                        results,
                                        JSON.stringify([request.session.client.clientId, request.sequence]),
                                        {
                                            clientId: request.session.client.clientId,
                                            sequence: request.sequence,
                                            entry,
                                        }
                                    );
                                })
                        );
                    })
                )
            );
            if (!admission.duplicate) yield* PubSub.publish(wakes, undefined);
            return yield* protocol.read(request.session, request.view);
        }),
        acknowledge: Effect.fn("OwnedBackend.acknowledgeClient")(
            function* (session, revision, through, viewGeneration) {
                const removed = yield* boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const record = yield* clients.acknowledge(
                                tx,
                                session,
                                revision,
                                through,
                                viewGeneration
                            );
                            const settled = yield* tx.loadSubset(results, {
                                where: and(
                                    eq(field("clientId"), record.client.clientId),
                                    lte(field("sequence"), record.acknowledgedThrough)
                                ),
                            });
                            for (const row of settled) yield* tx.delete(results, row.key);
                            if (settled.length) yield* bumpControl;
                            return settled.length;
                        })
                    )
                );
                if (removed) yield* PubSub.publish(wakes, undefined);
            }
        ),
    };
    return {
        name: "owned",
        sourceId: source,
        protocol,
        collectClientGarbage,
        supportsIdempotency: true,
        loadSubset: (subset) =>
            boundary(
                Effect.gen(function* () {
                    const object = model.objects[subset.objectType];
                    if (object)
                        for (const index of indexesForQuery(
                            subset.query ?? {},
                            new Set(object.definition.properties.map((property) => property.name))
                        ))
                            yield* storage.ensureIndex(object, index);
                    return yield* storage.read((native) =>
                        Effect.gen(function* () {
                            const rows = yield* read(native).loadSubset(subset.objectType, subset.query);
                            return { rows, complete: true, cursor: cursor(yield* current) };
                        })
                    );
                })
            ),
        invoke: Effect.fn("OwnedBackend.invoke")(function* (invocation: ActionInvocation) {
            const prepared = yield* prepare(invocation);
            const prior = yield* boundary(tables.get(receipts, receiptKey(invocation.id)));
            if (prior) {
                if (prior.fingerprint !== prepared.identity)
                    return yield* fault(
                        "invoke",
                        "Conflict",
                        "An invocation ID was reused with different parameters."
                    );
                return prior.receipt;
            }
            const commitUploads = invocation.attachmentUploads?.length
                ? options.prepareUploads
                    ? yield* options.prepareUploads(invocation)
                    : yield* fault(
                          "invoke",
                          "Unsupported",
                          "This owned backend has no attachment upload coordinator."
                      )
                : Effect.void;
            const result = yield* boundary(
                storage.transaction((native) => invokeIn(native, prepared, commitUploads, true))
            );
            if (result.changed) yield* PubSub.publish(wakes, undefined);
            return result.receipt;
        }),
        queryFunction: (name, parameters) =>
            boundary(
                storage.read((native) =>
                    Effect.gen(function* () {
                        const handler = options.queryFunctions?.[name];
                        const definition = options.ir.queryFunctionTypes.find(
                            (candidate) => candidate.name === name
                        );
                        if (!handler || !definition)
                            return yield* fault(
                                "query",
                                "Unsupported",
                                `No query implementation for ${JSON.stringify(name)}.`
                            );
                        const parsed = yield* Schema.decodeUnknownEffect(
                            Schema.toEncoded(schemas.queryParameterSchemas[name]!)
                        )(parameters).pipe(
                            Effect.mapError(() =>
                                fault("query", "Rejected", "Query parameters do not match their definition.")
                            )
                        );
                        const result = yield* handler(read(native), parsed);
                        return yield* Schema.decodeUnknownEffect(
                            Schema.toEncoded(schemas.queryReturnSchemas[name]!)
                        )(result).pipe(
                            Effect.mapError(() =>
                                fault("query", "Rejected", "Query result does not match its definition.")
                            )
                        );
                    })
                )
            ),
        changes: {
            pull: (request) =>
                boundary(
                    storage.read(() =>
                        Effect.gen(function* () {
                            const head = yield* current;
                            const after = yield* parseCursor(request.cursor, head);
                            const floor = (yield* tables.get(metadata, "head"))?.journalFloor ?? 0;
                            if (after < floor)
                                return yield* fault(
                                    "changes",
                                    "InvalidCursor",
                                    "Requested changes were compacted; acquire a fresh coordinated snapshot before resuming."
                                );
                            const limit = request.limit ?? 100;
                            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                                return yield* fault(
                                    "changes",
                                    "Rejected",
                                    "Change page limit must be between 1 and 1000."
                                );
                            const rows = yield* tables.loadSubset(journal, {
                                where: {
                                    op: "gt",
                                    left: { _tag: "Field", path: ["revision"] },
                                    right: after,
                                },
                                orderBy: [{ field: { _tag: "Field", path: ["revision"] } }],
                                limit: limit + 1,
                            });
                            const page = rows.slice(0, limit);
                            return {
                                commits: page.map((row) => row.value.commit),
                                cursor: cursor(page.at(-1)?.value.revision ?? head),
                                hasMore: rows.length > limit,
                            };
                        })
                    )
                ),
            watch: Stream.fromPubSub(wakes),
        },
        attachments: options.attachments,
        encrypted: options.encrypted,
    };
});
