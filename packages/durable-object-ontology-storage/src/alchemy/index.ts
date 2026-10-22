import { makeStorageOntologyBackend } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { DurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Effect } from "effect";
import { makeDurableObjectOntologyStorage } from "../index.js";
import { makeR2Bytes } from "../r2.js";
import type {
    OntologyIR,
    OntologyMutatorRegistry,
    OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2/ReadWriteBucket";

export { makeR2Bytes, r2BytesLayer } from "../r2.js";
export type { R2BytesOptions } from "../r2.js";

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
    const { tables, blobs } = yield* boundary(
        makeDurableObjectOntologyStorage({
            storage: state.raw.storage,
            ontologyId: options.ontologyId,
            bytes,
        })
    );
    const backend = yield* makeStorageOntologyBackend({
        ...options,
        namespace: options.ontologyId,
        tables,
        blobs,
    });
    return { backend, blobs, collectGarbage: backend.collectGarbage() };
});
