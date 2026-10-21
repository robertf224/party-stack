import { createReadTx } from "@party-stack/ontology";
import { executeTransactionMutator, withTransactionCollections } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { Effect } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import {
    getSQLiteAttachment,
    markSQLiteAttachmentUploadsComplete,
    persistSQLiteAttachmentRows,
    prepareSQLiteAttachments,
    readSQLiteAttachmentBlob,
    recordSQLiteAttachmentUploads,
} from "./attachments.js";
import { ensureSQLiteOntologySchema } from "./schema.js";
import type { CreateSQLiteOntologyBackendAdapterOptions } from "./index.js";

const fault = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "sqlite",
              kind: "Rejected",
              message: cause instanceof Error ? cause.message : "SQLite backend failed.",
              retryable: false,
              cause,
          });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: fault });
const sync = <A>(run: () => A) => Effect.try({ try: run, catch: fault });

/** The authoritative implementation. All action reads/writes and journal publication share one snapshot. */
export const makeSQLiteOntologyBackend = Effect.fn("SQLiteOntology.make")(function* (
    options: CreateSQLiteOntologyBackendAdapterOptions & { readonly context?: Record<string, unknown> }
) {
    yield* sync(() => ensureSQLiteOntologySchema(options.database, options.name ?? "sqlite"));
    const sql = yield* SQLite.makeClient(options.database).pipe(Effect.provide(Reactivity.layer));
    const tables = yield* SqlTables.make().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(fault)
    );
    return yield* makeOwnedBackend({
        namespace: options.name ?? "sqlite",
        ir: options.ir,
        tables,
        invocationScope: JSON.stringify(options.context?.user ?? "system"),
        mutators: Object.fromEntries(
            options.ir.actionTypes
                .filter((action) => action.logic.length || options.mutators?.[action.name])
                .map((action) => [
                    action.name,
                    (tx, invocation) =>
                        executeTransactionMutator({
                            ir: options.ir,
                            tx,
                            name: invocation.name,
                            parameters: invocation.parameters,
                            invocationId: invocation.id,
                            replay: invocation.replay,
                            context: options.context,
                            mutators: options.mutators,
                        }).pipe(Effect.asVoid),
                ])
        ),
        queryFunctions: Object.fromEntries(
            Object.entries(options.queryFunctions ?? {}).map(([name, handler]) => [
                name,
                (tx, parameters) =>
                    withTransactionCollections(options.ir, tx, (objects, ensureLoaded) =>
                        promise(async () =>
                            handler({
                                tx: createReadTx(objects, ensureLoaded),
                                args: parameters,
                                context: options.context ?? {},
                            })
                        )
                    ),
            ])
        ),
        prepareUploads: (invocation) =>
            Effect.gen(function* () {
                const prepared = yield* promise(() =>
                    prepareSQLiteAttachments({
                        uploads: invocation.attachmentUploads ? [...invocation.attachmentUploads] : undefined,
                        storage: options.attachmentStorage,
                    })
                );
                const external = prepared.filter((entry) => entry.storageKey !== null);
                if (external.length) {
                    yield* sql
                        .withTransaction(
                            sync(() => recordSQLiteAttachmentUploads(options.database, external))
                        )
                        .pipe(Effect.mapError(fault));
                    const bytes = options.attachmentStorage?.external?.bytes;
                    if (!bytes) return yield* fault(new Error("External attachment byte store is missing."));
                    for (const row of external) yield* promise(() => bytes.write(row.storageKey!, row.blob));
                    yield* sql
                        .withTransaction(
                            sync(() => markSQLiteAttachmentUploadsComplete(options.database, external))
                        )
                        .pipe(Effect.mapError(fault));
                }
                return sync(() => persistSQLiteAttachmentRows(options.database, prepared));
            }),
        attachments: {
            read: (value, range) =>
                Effect.gen(function* () {
                    const row = yield* sql
                        .withTransaction(sync(() => getSQLiteAttachment(options.database, value.id)))
                        .pipe(Effect.mapError(fault));
                    if (!row)
                        return yield* new BackendError({
                            operation: "attachment.read",
                            kind: "NotFound",
                            message: "Attachment not found.",
                            retryable: false,
                        });
                    const blob = yield* promise(() =>
                        readSQLiteAttachmentBlob({
                            row,
                            storage: options.attachmentStorage,
                            inlineBlobPart: (bytes) => {
                                if (bytes instanceof ArrayBuffer) return bytes;
                                if (ArrayBuffer.isView(bytes))
                                    return new Uint8Array(
                                        bytes.buffer,
                                        bytes.byteOffset,
                                        bytes.byteLength
                                    ).slice().buffer;
                                throw new TypeError("Attachment bytes are not a BLOB.");
                            },
                        })
                    );
                    if (!range) return blob;
                    if (
                        !Number.isSafeInteger(range.offset ?? 0) ||
                        (range.offset ?? 0) < 0 ||
                        (range.length !== undefined &&
                            (!Number.isSafeInteger(range.length) || range.length < 0))
                    )
                        return yield* fault(new RangeError("Invalid attachment byte range."));
                    return blob.slice(
                        range.offset ?? 0,
                        range.length === undefined ? undefined : (range.offset ?? 0) + range.length,
                        blob.type
                    );
                }),
            metadata: (value) =>
                sql
                    .withTransaction(
                        sync(() => {
                            const row = getSQLiteAttachment(options.database, value.id);
                            if (!row)
                                throw new BackendError({
                                    operation: "attachment.metadata",
                                    kind: "NotFound",
                                    message: "Attachment not found.",
                                    retryable: false,
                                });
                            return { size: row.size, type: row.type, name: row.name ?? value.id };
                        })
                    )
                    .pipe(Effect.mapError(fault)),
        },
    });
});
