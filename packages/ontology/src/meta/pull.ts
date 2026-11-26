import { pull as pullNative } from "@party-stack/ontology-backend/meta";
import { Effect } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { PullOptions, PullResult } from "@party-stack/ontology-backend/meta";
import type { OntologyIR } from "@party-stack/ontology-spec";
export type { PullOptions, PullResult } from "@party-stack/ontology-backend/meta";

/** Promise facade over native metadata queries; no replica or UI collections are acquired. */
export async function pull(
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions & { readonly includeOmitted: true }
): Promise<PullResult>;
export async function pull(
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions
): Promise<OntologyIR>;
export async function pull(
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions
): Promise<OntologyIR | PullResult> {
    return Effect.runPromise(pullNative(backend, options));
}
