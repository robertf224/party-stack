import { pull as pullNative } from "@party-stack/ontology-backend/meta";
import { Effect } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { PullOptions } from "@party-stack/ontology-backend/meta";
export type { PullOptions } from "@party-stack/ontology-backend/meta";

/** Promise facade over native metadata queries; no replica or UI collections are acquired. */
export async function pull(backend: Pick<OntologyBackendService, "query">, options: PullOptions) {
    return Effect.runPromise(pullNative(backend, options));
}
