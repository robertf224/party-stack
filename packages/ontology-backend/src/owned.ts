import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import {
    makeOntologyStorage,
    OntologyStorageError,
    makeStorageModel,
    and,
    eq,
    field,
    lte,
    indexesForQuery,
} from "@party-stack/ontology-storage";
import { digestBytes, byteSource } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Clock, Effect, PubSub, Schema, Stream } from "effect";
import { clientRegistry } from "./clients.js";
import { acknowledgeDelivery, makeDelivery, scanSelectedRows } from "./delivery.js";
import { actionReferenceIssues } from "./references.js";
import {
    classifyBackendFailure,
    schemaValidationIssues,
    BackendError,
    ActionReceiptSchema,
    BackendCommitSchema,
} from "./index.js";
import type { ClientPolicy } from "./clients.js";
import type {
    ActionRequest,
    ActionReceipt,
    BackendCommit,
    ObjectChange,
    OntologyBackendService,
} from "./index.js";
import type { ClientSubmission, OntologySource, PendingAction } from "./protocol.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type {
    Index,
    Key,
    Query,
    ReadStorageTransaction,
    StorageTransaction,
} from "@party-stack/ontology-storage";
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
/** Trusted persistence access, never exposed by the public backend/RPC contract. */
export interface OwnedStorageTransaction extends OwnedTransaction {
    ensureIndex(objectType: string, index: Index): Effect.Effect<void, BackendError>;
}
export interface OwnedStorageService {
    readonly ir: OntologyIR;
    readonly read: <A, E, R>(
        body: (tx: OwnedReadTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | BackendError, R>;
    /** Data changes and their journal batch commit in the same native transaction. */
    readonly transaction: <A, E, R>(
        body: (tx: OwnedStorageTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | BackendError, R>;
}
export interface OwnedBackendOptions {
    readonly namespace: string;
    readonly ir: OntologyIR;
    readonly tables: TablesService;
    readonly blobs?: import("@party-stack/ontology-storage/blobs").BlobStorageService;
    /** A trusted principal binding; invocation IDs are deduplicated within this authority scope. */
    readonly actionScope?: string;
    readonly clients?: ClientPolicy;
    /** Bounded replay history. Cursors behind this floor require a fresh snapshot. */
    readonly history?: { readonly maxCommits?: number; readonly maxAgeMs?: number };
    /** Infinity retains results indefinitely; finite windows bound idempotency. */
    readonly resultRetentionMs?: number;
    readonly mutators: Readonly<
        Record<string, (tx: OwnedTransaction, invocation: ActionRequest) => Effect.Effect<void, BackendError>>
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
        invocation: ActionRequest
    ) => Effect.Effect<Effect.Effect<void, BackendError>, BackendError>;
}
export interface OwnedBackendService extends OntologyBackendService {
    readonly storage: OwnedStorageService;
    /** Trusted protocol composition without an intermediate Replica or outbox. */
    readonly protocol: OntologySource;
    readonly collectClientGarbage: Effect.Effect<number, BackendError>;
}
const fault = (operation: string, kind: BackendError["kind"], message: string, cause?: unknown) =>
    new BackendError({ operation, kind, message, retryable: false, cause });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((error) => classifyBackendFailure("storage", error)));
const CursorSchema = Schema.Struct({ source: Schema.String, revision: Schema.Int });
const ReceiptSchema = Schema.Struct({
    fingerprint: Schema.String,
    receipt: ActionReceiptSchema,
    completedAt: Schema.Finite,
});
const JournalSchema = Schema.Struct({
    revision: Schema.Int,
    commit: BackendCommitSchema,
    committedAt: Schema.Finite,
});
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
        catch: (cause) => fault("definition", "InvalidConfiguration", "Invalid ontology definition.", cause),
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
    const schemaHash = yield* boundary(
        digestBytes({
            type: "application/json",
            stream: Stream.make(new TextEncoder().encode(JSON.stringify(options.ir))),
        })
    );
    const maxCommits = options.history?.maxCommits ?? 10_000;
    if ((maxCommits !== Infinity && !Number.isSafeInteger(maxCommits)) || maxCommits < 1)
        return yield* fault(
            "history",
            "InvalidConfiguration",
            "Journal retention requires a positive commit bound."
        );
    const resultRetentionMs = options.resultRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (resultRetentionMs <= 0 || Number.isNaN(resultRetentionMs))
        return yield* fault("retention", "InvalidConfiguration", "Result retention must be positive.");
    if (
        options.history?.maxAgeMs !== undefined &&
        (options.history.maxAgeMs < 0 || Number.isNaN(options.history.maxAgeMs))
    )
        return yield* fault(
            "retention",
            "InvalidConfiguration",
            "Journal retention age must be nonnegative."
        );
    const receiptKey = (id: string) => JSON.stringify([options.actionScope ?? "system", id]);
    const metadata = Table.make<{ revision: number; source: string; journalFloor?: number }>({
        name: JSON.stringify(["backend", options.namespace, "metadata"]),
    });
    const receipts = Table.make<{ fingerprint: string; receipt: ActionReceipt; completedAt: number }>({
        name: JSON.stringify(["backend", options.namespace, "receipts"]),
        codec: {
            encode: (value) => Schema.encodeSync(ReceiptSchema)(value),
            decode: (value) =>
                Schema.decodeUnknownSync(ReceiptSchema)(value) as {
                    fingerprint: string;
                    receipt: ActionReceipt;
                    completedAt: number;
                },
        },
    });
    const journal = Table.make<{ revision: number; commit: BackendCommit; committedAt: number }>({
        name: JSON.stringify(["backend", options.namespace, "journal"]),
        codec: {
            encode: (value) => Schema.encodeSync(JournalSchema)(value),
            decode: (value) =>
                Schema.decodeUnknownSync(JournalSchema)(value) as {
                    revision: number;
                    commit: BackendCommit;
                    committedAt: number;
                },
        },
    });
    let source = "";
    const cursor = (revision: number) => JSON.stringify({ source, revision });
    const parseCursor = Effect.fnUntraced(function* (encoded: string | undefined, current: number) {
        if (encoded === undefined) return 0;
        const parsed = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(Schema.fromJsonString(CursorSchema))(encoded),
            catch: () => fault("changes", "HistoryExpired", "Invalid backend change cursor."),
        });
        if (parsed.source !== source)
            return yield* fault("changes", "SourceMismatch", "Change cursor belongs to a different source.");
        if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || parsed.revision > current)
            return yield* fault("changes", "HistoryExpired", "Invalid backend change position.");
        return parsed.revision;
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
            : Effect.fail(fault("object", "InvalidRequest", `Unknown object type ${JSON.stringify(name)}.`));
    };
    const read = (native: ReadStorageTransaction): OwnedReadTransaction => ({
        get: (name, key) => boundary(Effect.flatMap(object(name), (store) => native.get(store, key))),
        loadSubset: (name, query) =>
            boundary(Effect.flatMap(object(name), (store) => native.loadSubset(store, query))),
    });
    const mutation = (native: StorageTransaction) => {
        const changes = new Map<string, ObjectChange>();
        const tx: OwnedStorageTransaction = {
            ensureIndex: (name, index) =>
                boundary(Effect.flatMap(object(name), (store) => native.ensureIndex(store, index))),
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
        return { tx, changes };
    };
    const append = Effect.fnUntraced(function* (
        changes: ReadonlyMap<string, ObjectChange>,
        operationId?: string
    ) {
        const revision = (yield* current) + 1;
        if (!Number.isSafeInteger(revision))
            return yield* fault("commit", "Unavailable", "Backend journal revision exhausted.");
        const encodedCursor = cursor(revision);
        const commit: BackendCommit = { cursor: encodedCursor, operationId, changes: [...changes.values()] };
        yield* tables.put(journal, revision, {
            revision,
            commit,
            committedAt: yield* Clock.currentTimeMillis,
        });
        const journalFloor = Math.max(
            (yield* tables.get(metadata, "head"))?.journalFloor ?? 0,
            Number.isFinite(maxCommits) ? revision - maxCommits : 0
        );
        for (const row of yield* tables.loadSubset(journal, { where: lte(field("revision"), journalFloor) }))
            yield* tables.delete(journal, row.key);
        yield* tables.put(metadata, "head", { revision, source, journalFloor });
        return encodedCursor;
    });
    const trustedStorage: OwnedStorageService = {
        ir: options.ir,
        read: (body) =>
            storage
                .read((native) => body(read(native)))
                .pipe(
                    Effect.mapError((error) =>
                        error instanceof OntologyStorageError
                            ? classifyBackendFailure("storage", error)
                            : error
                    )
                ),
        transaction: (body) =>
            Effect.gen(function* () {
                const result = yield* storage
                    .transaction((native) =>
                        Effect.gen(function* () {
                            const { tx, changes } = mutation(native);
                            const value = yield* body(tx);
                            if (changes.size) yield* append(changes);
                            return { value, changed: changes.size > 0 };
                        })
                    )
                    .pipe(
                        Effect.mapError((error) =>
                            error instanceof OntologyStorageError
                                ? classifyBackendFailure("storage", error)
                                : error
                        )
                    );
                if (result.changed) yield* PubSub.publish(wakes, undefined);
                return result.value;
            }),
    };
    const prepare = Effect.fn("OwnedBackend.prepare")(function* (invocation: ActionRequest) {
        const parameterSchema = schemas.actionParameterSchemas[invocation.name];
        if (!parameterSchema || !options.mutators[invocation.name])
            return yield* fault(
                "applyAction",
                "NotImplemented",
                `No action implementation for ${JSON.stringify(invocation.name)}.`
            );
        if (!invocation.id)
            return yield* fault("applyAction", "InvalidRequest", "Actions require a stable invocation ID.");
        const encodedParameters = yield* Schema.encodeEffect(
            Schema.toCodecJson(Schema.toEncoded(parameterSchema))
        )(invocation.parameters).pipe(
            Effect.mapError(
                (error) =>
                    new BackendError({
                        operation: "applyAction",
                        kind: "ValidationFailed",
                        message: "Action parameters do not match their definition.",
                        retryable: false,
                        actionOutcome: "not-committed",
                        issues: schemaValidationIssues(error),
                    })
            )
        );
        const attachmentIdentity = yield* Effect.forEach(invocation.attachmentUploads ?? [], (upload) =>
            digestBytes(upload.blob).pipe(
                Effect.map((digest) => ({
                    id: upload.attachment.id,
                    target: upload.target,
                    type: byteSource(upload.blob).type,
                    size: byteSource(upload.blob).size,
                    digest,
                })),
                Effect.mapError((cause) =>
                    fault("upload", "InvalidRequest", "Cannot identify attachment bytes.", cause)
                )
            )
        );
        // A preflight avoids staging duplicate uploads on ordinary receipt retries. The
        // write transaction below rechecks identity to resolve concurrent invocations.
        const identity = JSON.stringify(
            stableValue([invocation.name, encodedParameters, attachmentIdentity, invocation.replay])
        );
        return { invocation, identity };
    });
    const invokeIn = Effect.fnUntraced(function* (
        native: StorageTransaction,
        prepared: { invocation: ActionRequest; identity: string },
        commitUploads: Effect.Effect<void, BackendError>,
        retainReceipt: boolean
    ) {
        const { invocation } = prepared;
        const action = options.ir.actionTypes.find((candidate) => candidate.name === invocation.name);
        const mutator = options.mutators[invocation.name];
        if (!action || !mutator)
            return yield* fault(
                "applyAction",
                "NotImplemented",
                `No action implementation for ${JSON.stringify(invocation.name)}.`
            );
        if (!invocation.id)
            return yield* fault("applyAction", "InvalidRequest", "Actions require a stable invocation ID.");
        const parameters = yield* Schema.decodeUnknownEffect(
            Schema.toEncoded(schemas.actionParameterSchemas[invocation.name]!)
        )(invocation.parameters).pipe(
            Effect.mapError(
                (error) =>
                    new BackendError({
                        operation: "applyAction",
                        kind: "ValidationFailed",
                        message: "Action parameters do not match their definition.",
                        retryable: false,
                        actionOutcome: "not-committed",
                        issues: schemaValidationIssues(error),
                    })
            )
        );
        const fingerprint = prepared.identity;
        const previous = retainReceipt ? yield* tables.get(receipts, receiptKey(invocation.id)) : undefined;
        if (previous && previous.completedAt > (yield* Clock.currentTimeMillis) - resultRetentionMs) {
            if (previous.fingerprint !== fingerprint)
                return yield* fault(
                    "applyAction",
                    "Conflict",
                    "An invocation ID was reused with different parameters."
                );
            return { receipt: previous.receipt, changed: false };
        }
        const issues = yield* actionReferenceIssues(options.ir, action.parameters, parameters, read(native));
        if (issues.length)
            return yield* new BackendError({
                operation: "applyAction",
                kind: "ValidationFailed",
                message: "Submission failed validation.",
                retryable: false,
                actionOutcome: "not-committed",
                issues,
            });
        const { tx, changes } = mutation(native);
        yield* mutator(tx, { ...invocation, parameters });
        yield* commitUploads;
        const affected = new Map<string, Set<Key>>();
        for (const change of changes.values()) {
            const keys = affected.get(change.objectType) ?? new Set<Key>();
            keys.add(change.key);
            affected.set(change.objectType, keys);
        }
        const receipt: ActionReceipt = {
            affected: [...affected].map(([objectType, keys]) => ({ objectType, keys: [...keys] })),
            affectedComplete: true,
            operationId: invocation.id,
            outcome: "committed",
            cursor: yield* append(changes, invocation.id),
        };
        if (retainReceipt)
            yield* tables.put(receipts, receiptKey(invocation.id), {
                fingerprint,
                receipt,
                completedAt: yield* Clock.currentTimeMillis,
            });
        return {
            receipt,
            changed: true,
            touchedTypes: [...new Set([...changes.values()].map((change) => change.objectType))],
        };
    });
    const clientNamespace = JSON.stringify(["owned", options.namespace, options.actionScope ?? "system"]);
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
                    name: "operationId",
                    field: field("entry", "invocation", "id"),
                });
            })
        )
    );
    const collectClientGarbage = boundary(tables.transaction((tx) => clients.expire(tx))).pipe(
        Effect.tap((expired) => (expired.length ? PubSub.publish(wakes, undefined) : Effect.void)),
        Effect.map((expired) => expired.length)
    );
    yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.ensureIndex(receipts, { name: "completedAt", field: field("completedAt") });
                yield* tx.ensureIndex(journal, { name: "committedAt", field: field("committedAt") });
                yield* tx.ensureIndex(results, { name: "completedAt", field: field("entry", "completedAt") });
            })
        )
    );
    const collectGarbage = boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* clients.expire(tx);
                const now = yield* Clock.currentTimeMillis;
                if (Number.isFinite(resultRetentionMs)) {
                    for (const row of yield* tx.loadSubset(receipts, {
                        where: lte(field("completedAt"), now - resultRetentionMs),
                        limit: 100,
                    }))
                        yield* tx.delete(receipts, row.key);
                    for (const row of yield* tx.loadSubset(results, {
                        where: lte(field("entry", "completedAt"), now - resultRetentionMs),
                        limit: 100,
                    }))
                        yield* tx.delete(results, row.key);
                }
                if (options.history?.maxAgeMs !== undefined && Number.isFinite(options.history.maxAgeMs)) {
                    const expired = yield* tx.loadSubset(journal, {
                        where: lte(field("committedAt"), now - options.history.maxAgeMs),
                        orderBy: [{ field: field("revision") }],
                        limit: 100,
                    });
                    const head = yield* tx.get(metadata, "head");
                    if (head && expired.length)
                        yield* tx.put(metadata, "head", {
                            ...head,
                            journalFloor: Math.max(
                                head.journalFloor ?? 0,
                                ...expired.map((row) => row.value.revision)
                            ),
                        });
                    for (const row of expired) yield* tx.delete(journal, row.key);
                }
            })
        )
    );
    const subscribeSelection: NonNullable<OntologyBackendService["subscribeSelection"]> = (
        selection,
        policy
    ) =>
        makeDelivery({
            tables: { ...tables, transaction: (body) => storage.transaction(() => body(tables)) },
            namespace: options.namespace,
            policy,
            changes: PubSub.subscribe(wakes).pipe(Effect.map(Stream.fromSubscription)),
            capture: (_tx, emit) =>
                boundary(
                    Effect.gen(function* () {
                        for (const subset of selection.subsets) {
                            const store = yield* object(subset.objectType);
                            yield* scanSelectedRows(
                                (query) => boundary(storage.loadSubset(store, query)),
                                subset.query,
                                (row) => emit({ kind: "base", objectType: subset.objectType, ...row })
                            );
                        }
                        const revision = yield* current;
                        return {
                            sourceId: source,
                            schemaHash,
                            generation: 1,
                            revision: revision + 1,
                            cursor: cursor(revision),
                            coverage: selection.subsets.map((subset) => ({ subset, complete: true })),
                        };
                    })
                ),
        });
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
                    "InvalidRequest",
                    "Protocol submissions require an invocation ID and staged attachment handles."
                );
            if (
                request.view &&
                !request.view.selection.inspectActions &&
                !request.view.selection.actionIds.includes(request.invocation.id)
            )
                return yield* fault(
                    "protocol",
                    "InvalidRequest",
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
                                        requestIdentity: Table.make<ActionRequest>({
                                            name: "identity",
                                        }).encode(request.invocation),
                                        createdAt: yield* Clock.currentTimeMillis,
                                        completedAt: yield* Clock.currentTimeMillis,
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
            yield* collectGarbage.pipe(Effect.catch(() => Effect.void));
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
        storage: trustedStorage,
        sourceId: source,
        protocol,
        collectClientGarbage,
        maintenance: collectGarbage,
        supportsIdempotency: true,
        subscribeSelection,
        acknowledgeDelivery: (position) => acknowledgeDelivery(tables, options.namespace, position),
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
        applyAction: Effect.fn("OwnedBackend.applyAction")(function* (invocation: ActionRequest) {
            const prepared = yield* prepare(invocation);
            const prior = yield* boundary(tables.get(receipts, receiptKey(invocation.id)));
            if (prior && prior.completedAt > (yield* Clock.currentTimeMillis) - resultRetentionMs) {
                if (prior.fingerprint !== prepared.identity)
                    return yield* fault(
                        "applyAction",
                        "Conflict",
                        "An invocation ID was reused with different parameters."
                    );
                return prior.receipt;
            }
            const commitUploads = invocation.attachmentUploads?.length
                ? options.prepareUploads
                    ? yield* options.prepareUploads(invocation)
                    : yield* fault(
                          "applyAction",
                          "NotImplemented",
                          "This owned backend has no attachment upload coordinator."
                      )
                : Effect.void;
            const result = yield* boundary(
                storage.transaction((native) => invokeIn(native, prepared, commitUploads, true))
            );
            if (result.changed) yield* PubSub.publish(wakes, undefined);
            // Keep cleanup throughput proportional to writes, in addition to idle maintenance.
            // A maintenance failure cannot overwrite a successful commit outcome.
            yield* collectGarbage.pipe(Effect.catch(() => Effect.void));
            return result.receipt;
        }),
        validateAction: (name, parameters, settings) =>
            Effect.gen(function* () {
                const action = options.ir.actionTypes.find((action) => action.name === name);
                if (!action) return yield* fault("validateAction", "NotImplemented", "Unknown action type.");
                const known = settings?.knownParameters;
                const definition = known
                    ? {
                          ...action,
                          parameters: action.parameters.filter(
                              (parameter) =>
                                  known.includes(parameter.name) || parameters[parameter.name] !== undefined
                          ),
                      }
                    : action;
                const schema =
                    definition === action
                        ? schemas.actionParameterSchemas[name]!
                        : compileEffectSchemas({ ...options.ir, actionTypes: [definition] })
                              .actionParameterSchemas[name]!;
                const result = yield* Effect.result(
                    Schema.decodeUnknownEffect(Schema.toEncoded(schema))(parameters)
                );
                if (result._tag === "Failure")
                    return {
                        certain: true as const,
                        value: { kind: "err" as const, value: schemaValidationIssues(result.failure) },
                    };
                const referenceIssues = yield* boundary(
                    storage.read((native) =>
                        actionReferenceIssues(options.ir, definition.parameters, result.success, read(native))
                    )
                );
                if (referenceIssues.length)
                    return {
                        certain: true as const,
                        value: { kind: "err" as const, value: referenceIssues },
                    };
                // Shape validation cannot execute arbitrary mutator business logic, and
                // successful preflight never promises a later transaction will commit.
                return { certain: false as const };
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
                                "NotImplemented",
                                `No query implementation for ${JSON.stringify(name)}.`
                            );
                        const parsed = yield* Schema.decodeUnknownEffect(
                            Schema.toEncoded(schemas.queryParameterSchemas[name]!)
                        )(parameters).pipe(
                            Effect.mapError(() =>
                                fault(
                                    "query",
                                    "ValidationFailed",
                                    "Query parameters do not match their definition."
                                )
                            )
                        );
                        const result = yield* handler(read(native), parsed);
                        return yield* Schema.decodeUnknownEffect(
                            Schema.toEncoded(schemas.queryReturnSchemas[name]!)
                        )(result).pipe(
                            Effect.mapError(() =>
                                fault("query", "Internal", "Query result does not match its definition.")
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
                                    "HistoryExpired",
                                    "Requested changes were compacted; acquire a fresh coordinated snapshot before resuming."
                                );
                            const limit = request.limit ?? 100;
                            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                                return yield* fault(
                                    "changes",
                                    "InvalidRequest",
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
