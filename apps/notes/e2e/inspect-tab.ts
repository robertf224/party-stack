import { isCollection, type Collection } from "@tanstack/db";
import { queryConsumers } from "../../../packages/ontology-devtools/lib/attribution/registry.js";
import { queryDemandGraph } from "../../../packages/ontology-devtools/lib/attribution/tanstack.js";

const changes: object[] = [];
const observed = new WeakSet<object>();

export function noteSources() {
    const sources = new Set<Collection<object>>();
    for (const { collection } of queryConsumers())
        for (const demand of queryDemandGraph(collection))
            if (demand.objectType === "Note" && isCollection(demand.collection))
                sources.add(demand.collection);
    return sources;
}

/** Test-only observation of already-running source sync. No query or upstream demand. */
export function recordTabChanges() {
    for (const { collection } of queryConsumers()) {
        for (const demand of queryDemandGraph(collection)) {
            const source = demand.collection;
            if (demand.objectType !== "Note" || observed.has(source) || !isCollection(source)) continue;
            observed.add(source);
            source.subscribeChanges(
                (batch) => {
                    for (const change of batch)
                        changes.push({
                            key: change.key,
                            type: change.type,
                            trashed: Reflect.get(change.value, "trashed"),
                            previous: change.previousValue && Reflect.get(change.previousValue, "trashed"),
                        });
                    if (changes.length > 500) changes.splice(0, changes.length - 500);
                },
                { includeInitialState: false }
            );
        }
    }
}

/** Snapshot existing debug registrations; creates no query, demand or row cache. */
export function inspectTab(ids: readonly string[]) {
    const sources = new Set<Collection<object>>();
    const consumers = queryConsumers().flatMap(({ owner, collection }) => {
        for (const demand of queryDemandGraph(collection))
            if (demand.objectType === "Note" && isCollection(demand.collection))
                sources.add(demand.collection);
        if (!["NoteList", "NoteMenu", "NotePreview"].includes(owner.name) || !isCollection(collection))
            return [];
        const rows = [...collection.values()].filter((row) => ids.includes(String(Reflect.get(row, "id"))));
        return [
            {
                owner: owner.name,
                id: collection.id,
                rows: rows.map((row) => ({
                    id: Reflect.get(row, "id"),
                    trashed: Reflect.get(row, "trashed"),
                })),
                status: collection.status,
                isLoadingSubset: collection.isLoadingSubset,
                demands:
                    owner.name === "NoteList"
                        ? queryDemandGraph(collection).map(
                              ({ subscription: _subscription, collection: _collection, ...request }) =>
                                  request
                          )
                        : undefined,
            },
        ];
    });
    return {
        sources: [...sources].map((collection) => ({
            id: collection.id,
            // Diagnostic comparison only; application rendering stays on live queries.
            values: ids.map((id) => {
                const row = collection.get(id);
                return { id, trashed: row && Reflect.get(row, "trashed") };
            }),
        })),
        consumers,
        changes,
    };
}
