import { createReadTx, executeTransactionMutator, withTransactionCollections } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { DurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Effect } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { createDurableObjectSQLiteDatabase } from "../index.js";
import { makeAlchemyR2Bytes } from "./r2.js";
import type {
    OntologyIR,
    OntologyMutatorRegistry,
    OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2/ReadWriteBucket";

export { makeAlchemyR2Bytes, alchemyR2BytesLayer } from "./r2.js";
export type { AlchemyR2BytesOptions } from "./r2.js";

export interface AlchemyOntologyOptions {
    readonly ir: OntologyIR;
    readonly bucket: ReadWriteBucketClient;
    readonly ontologyId: string;
    readonly context?: Record<string, unknown>;
    readonly mutators?: OntologyMutatorRegistry;
    readonly queryFunctions?: OntologyQueryFunctionRegistry;
}
const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "alchemy-ontology",
              kind: "Unavailable",
              message: "Durable Object ontology storage failed.",
              retryable: false,
              cause,
          });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(failure));
const promise = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: failure });
const digest = (blob: Blob) =>
    promise(async () => {
        const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    });

/** Acquire in Alchemy's inner DO constructor. Application rows and blob metadata share Tables. */
export const makeAlchemyOntology = Effect.fn("AlchemyOntology.make")(function* (
    options: AlchemyOntologyOptions
) {
    const state = yield* DurableObjectState;
    const database = createDurableObjectSQLiteDatabase(state.raw.storage);
    const sql = yield* SQLite.makeClient(database).pipe(Effect.provide(Reactivity.layer));
    const tables = yield* boundary(SqlTables.make().pipe(Effect.provideService(SqlClient.SqlClient, sql)));
    const identity = Table.make<{ ontologyId: string }>({ name: "party-stack:durable-object:ontology" });
    yield* boundary(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                const previous = yield* tx.get(identity, "identity");
                if (previous && previous.ontologyId !== options.ontologyId)
                    return yield* new BackendError({
                        operation: "ontology",
                        kind: "Conflict",
                        message:
                            "A Durable Object hosts one ontology; use a different object for another ontology.",
                        retryable: false,
                    });
                yield* tx.put(identity, "identity", { ontologyId: options.ontologyId });
            })
        )
    );
    const bytes = yield* makeAlchemyR2Bytes({
        bucket: options.bucket,
        installationId: state.id.toString(),
        ontologyId: options.ontologyId,
    });
    const blobs = yield* boundary(
        makeBlobStorage({ namespace: options.ontologyId, tables, bytes, mode: "authoritative" })
    );
    const backend = yield* makeOwnedBackend({
        namespace: options.ontologyId,
        ir: options.ir,
        tables,
        blobs,
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
        prepareUploads: Effect.fn("AlchemyOntology.prepareUploads")(function* (invocation) {
            for (const upload of invocation.attachmentUploads ?? []) {
                const stored = yield* boundary(blobs.metadata(upload.attachment.id));
                if (stored?.byteKey) {
                    // IDs identify immutable content. Reusing the same upload is idempotent.
                    const existing = yield* boundary(blobs.read(upload.attachment.id));
                    if (!existing || (yield* digest(existing)) !== (yield* digest(upload.blob)))
                        return yield* new BackendError({
                            operation: "upload",
                            kind: "Conflict",
                            message: "An attachment ID was reused for different bytes.",
                            retryable: false,
                        });
                } else {
                    yield* boundary(blobs.stage(upload.attachment.id, upload.blob));
                }
            }
            // These service operations join the action's contextual Tables transaction.
            return boundary(
                Effect.forEach(
                    invocation.attachmentUploads ?? [],
                    (upload) => blobs.in(tables).bindRemoteId(upload.attachment.id, upload.attachment.id),
                    { discard: true }
                )
            );
        }),
        attachments: {
            read: (attachment, range) =>
                boundary(
                    Effect.gen(function* () {
                        const content = yield* blobs.read(attachment.id);
                        if (!content)
                            return yield* new BackendError({
                                operation: "attachment.read",
                                kind: "NotFound",
                                message: "Attachment not found.",
                                retryable: false,
                            });
                        if (!range) return content;
                        if (
                            !Number.isSafeInteger(range.offset ?? 0) ||
                            (range.offset ?? 0) < 0 ||
                            (range.length !== undefined &&
                                (!Number.isSafeInteger(range.length) || range.length < 0))
                        )
                            return yield* new BackendError({
                                operation: "attachment.read",
                                kind: "Rejected",
                                message: "Invalid attachment range.",
                                retryable: false,
                            });
                        return content.slice(
                            range.offset ?? 0,
                            range.length === undefined ? undefined : (range.offset ?? 0) + range.length,
                            content.type
                        );
                    })
                ),
            metadata: (attachment) =>
                boundary(
                    Effect.gen(function* () {
                        const record = yield* blobs.metadata(attachment.id);
                        if (!record || record.size === undefined || record.type === undefined)
                            return yield* new BackendError({
                                operation: "attachment.metadata",
                                kind: "NotFound",
                                message: "Attachment not found.",
                                retryable: false,
                            });
                        return { size: record.size, type: record.type, name: record.name ?? attachment.id };
                    })
                ),
        },
    });
    return { backend, blobs, collectGarbage: boundary(blobs.collectGarbage({ olderThanMs: 0 })) };
});
