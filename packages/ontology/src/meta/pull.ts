import { pull as pullNative } from "@party-stack/ontology-backend/meta";
import { Effect } from "effect";
import type { LiveOntology } from "../live/LiveOntology.js";
import type { PullOptions } from "@party-stack/ontology-backend/meta";
import type { MetaOntology } from "@party-stack/ontology-spec/meta";
export type { PullOptions } from "@party-stack/ontology-backend/meta";

/** Promise facade over native metadata loading. */
export async function pull(ontology: LiveOntology<MetaOntology>, options: PullOptions) {
    const replica = ontology.storage;
    if (!replica) throw new Error("Metadata pull requires a native replica.");
    return Effect.runPromise(
        pullNative(
            {
                loadSubset: (subset) =>
                    Effect.scoped(
                        Effect.gen(function* () {
                            yield* replica.demand.acquire(subset);
                            return { rows: yield* replica.readSubset(subset), complete: true };
                        })
                    ),
            },
            options
        )
    );
}
