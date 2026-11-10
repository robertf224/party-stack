import { Query, queryOnce } from "@tanstack/db";
import type { OntologyMutatorObjects, OntologyReadTx, PrepareTransactionSources } from "./types.js";

export function createReadTx(
    objects: OntologyMutatorObjects,
    ensureLoaded?: PrepareTransactionSources
): OntologyReadTx {
    return {
        query: async (build) => {
            if (!ensureLoaded) return queryOnce((query) => build(query, objects) as never);
            const sources = new Set<string>();
            const tracked = new Proxy(objects, {
                get: (target, name) => {
                    if (typeof name === "string" && name in target) sources.add(name);
                    return Reflect.get(target, name);
                },
            });
            const plan = build(new Query(), tracked);
            await ensureLoaded([...sources], { plan });
            return queryOnce({ query: plan as never });
        },
    };
}
