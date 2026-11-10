import { BackendError } from "@party-stack/ontology-backend";
import { makeStorageBackend, type StorageBackendOptions } from "@party-stack/ontology-backend/storage";
import { DurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Effect } from "effect";
import { makeDurableObjectOntologyStorage } from "../index.js";
import { makeR2Bytes } from "../r2.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2/ReadWriteBucket";

export interface AlchemyOntologyOptions {
    readonly ir: OntologyIR;
    readonly bucket: ReadWriteBucketClient;
    readonly ontologyId: string;
    /** SQLite quota for this deployment; omitted quotas remain unknown. */
    readonly storageLimitBytes?: number;
    /** Authority-owned key service; can use Workers secrets or an external key-management service. */
    readonly encryptionKeyring?: EncryptionKeyringService;
    readonly context?: Record<string, unknown>;
    readonly mutators?: StorageBackendOptions["mutators"];
    readonly queryFunctions?: StorageBackendOptions["queryFunctions"];
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
/** Acquire in Alchemy's inner DO constructor. Application rows and blob metadata share Tables. */
export const makeAlchemyOntology = Effect.fn("AlchemyOntology.make")(function* (
    options: AlchemyOntologyOptions
) {
    const state = yield* DurableObjectState;
    const bytes = yield* makeR2Bytes({
        bucket: options.bucket,
        installationId: state.id.toString(),
        ontologyId: options.ontologyId,
    });
    const { tables, blobs, capacity } = yield* boundary(
        makeDurableObjectOntologyStorage({
            storage: state.raw.storage,
            ontologyId: options.ontologyId,
            storageLimitBytes: options.storageLimitBytes,
            bytes,
        })
    );
    const backend = yield* makeStorageBackend({
        ...options,
        namespace: options.ontologyId,
        // DO alarms own maintenance; an in-memory interval must not prevent hibernation.
        maintenance: false,
        tables,
        blobs,
    });
    return { backend, blobs, capacity, collectGarbage: backend.collectGarbage() };
});
