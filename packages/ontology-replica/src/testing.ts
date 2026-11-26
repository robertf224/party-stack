import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { Effect, PubSub, Stream } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
// Private fault-injection seam. Not exported from the package.
export * from "./engine.js";
export { makeReplicaKernel as makeReplica } from "./engine.js";
export { makeCachedProxy } from "./proxy.js";
export { connectReplicaParent, replicaStateSource } from "./parent.js";

/** Metadata serving an editable definition, for tests of dynamic definitions. Watches report
 * each edit. */
export const editableMetadata = (initial: import("@party-stack/ontology-spec").OntologyIR) =>
    Effect.gen(function* () {
        let current = initial;
        const edits = yield* PubSub.unbounded<void>();
        const backend: OntologyBackendService = {
            ...makeMetadataBackend(initial),
            loadSubset: (subset) => Effect.suspend(() => makeMetadataBackend(current).loadSubset(subset)),
            query: (document, settings) =>
                Effect.suspend(() => makeMetadataBackend(current).query(document, settings)),
            watchSubset: () =>
                Effect.map(PubSub.subscribe(edits), (subscription) =>
                    Stream.as(Stream.fromSubscription(subscription), "reset" as const)
                ),
        };
        return {
            backend,
            edit: (next: import("@party-stack/ontology-spec").OntologyIR) =>
                Effect.suspend(() => {
                    current = next;
                    return PubSub.publish(edits, undefined);
                }),
        };
    });
