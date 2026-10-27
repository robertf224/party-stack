import { BackendError } from "@party-stack/ontology-backend";
import { collectActionAttachments } from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";
import type { BlobManager } from "../../runtime/blobs/types.js";
import type { OntologyAttachmentUpload } from "../OntologyBackendAdapter.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const failure = (cause: unknown) =>
    new BackendError({
        operation: "attachment.prepare",
        kind: "Unavailable",
        message: "Attachment bytes could not be prepared.",
        retryable: true,
        actionOutcome: "not-committed",
        cause,
    });

/** Collect only locally staged bytes. Provider upload/rewriting belongs to applyAction;
 * cached remote handles must not trigger downloads just because an action reuses them.
 */
export const prepareActionParameters = Effect.fn("Ontology.prepareActionParameters")(function* (opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    blobManager?: BlobManager;
}) {
    const attachments = collectActionAttachments(opts.ir, opts.actionTypeName, opts.parameters);
    if (!attachments.length) return { parameters: opts.parameters, attachmentUploads: [] };
    const manager = opts.blobManager;
    if (!manager)
        return yield* new BackendError({
            operation: "attachment.prepare",
            kind: "NotImplemented",
            message: "Attachment storage is unavailable.",
            retryable: false,
            actionOutcome: "not-committed",
        });
    const storage = yield* Effect.tryPromise({ try: () => manager.storage, catch: failure });
    const uploads: OntologyAttachmentUpload[] = [];
    for (const entry of attachments) {
        const record = yield* storage.metadata(entry.attachment.id).pipe(Effect.mapError(failure));
        if (record?.state !== "staged" || record.remoteId) continue;
        const blob = yield* Effect.tryPromise({
            try: (signal) => manager.read(entry.attachment.id, { signal }),
            catch: failure,
        });
        uploads.push({ ...entry, blob });
    }
    return { parameters: opts.parameters, attachmentUploads: uploads };
});
