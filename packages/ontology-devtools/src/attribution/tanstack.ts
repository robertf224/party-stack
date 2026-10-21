import { getCollectionDemands, type CollectionDemandDiagnostic } from "@party-stack/runtime";
import { demandId, type ReplicationDemand } from "../replicationActivity.js";
import { queryConsumers, type DemandOwner } from "./registry.js";

interface Graph {
    getSourceCollections(): readonly object[];
    readonly subscriptions: Record<string, object>;
}
/** TanStack DB 0.14 adapter. Private inspection is confined here and fails closed.
 * No subscriptions, sync runs, queries, or row reads are created by inspection.
 */
function queryGraph(collection: object): Graph | undefined {
    const utils = (collection as { utils?: object }).utils;
    if (!utils) return;
    const key = Object.getOwnPropertySymbols(utils).find(
        (symbol) => symbol.description === "liveQueryInternal"
    );
    if (!key) return;
    const utility = Reflect.get(utils, key) as { getBuilder?: () => Graph } | undefined;
    if (typeof utility?.getBuilder !== "function") return;
    const graph = utility.getBuilder();
    return typeof graph?.getSourceCollections === "function" &&
        graph.subscriptions &&
        typeof graph.subscriptions === "object"
        ? graph
        : undefined;
}

export function queryDemandGraph(
    collection: object
): readonly (CollectionDemandDiagnostic & { collection: object })[] {
    const result: (CollectionDemandDiagnostic & { collection: object })[] = [];
    const seen = new Set<object>();
    const visit = (current: object) => {
        if (seen.has(current)) return;
        seen.add(current);
        // A pooled hook result is a lazy Proxy: reading .utils would materialize
        // another query and acquire demand. Inspect its own data descriptors only.
        const own = (key: string) => Object.getOwnPropertyDescriptor(current, key)?.value;
        const source = own("source") as object | undefined;
        const partition = own("partition") as object | undefined;
        if (source && partition && typeof own("groupKey") === "string") {
            const partitionSource = Object.getOwnPropertyDescriptor(partition, "source")?.value;
            const subscription = Object.getOwnPropertyDescriptor(partition, "subscription")?.value;
            if (partitionSource !== source) return;
            for (const demand of getCollectionDemands(source))
                if (subscription && demand.subscription === subscription)
                    result.push({ ...demand, collection: source });
            visit(source);
            const materialized = own("collection") as object | undefined;
            if (materialized) visit(materialized);
            return;
        }
        const graph = queryGraph(current);
        if (!graph) return;
        const subscriptions = new Set(Object.values(graph.subscriptions));
        for (const source of graph.getSourceCollections()) {
            for (const demand of getCollectionDemands(source))
                if (demand.subscription && subscriptions.has(demand.subscription))
                    result.push({ ...demand, collection: source });
            visit(source);
        }
    };
    try {
        visit(collection);
    } catch {
        return [];
    }
    return result;
}

export function demandOwners(
    demand: Pick<ReplicationDemand, "objectType" | "query">,
    sources: readonly object[]
): readonly DemandOwner[] {
    const key = demandId(demand);
    const roots = new Set(sources);
    const owners = new Map<string, DemandOwner>();
    for (const consumer of queryConsumers())
        if (
            queryDemandGraph(consumer.collection).some(
                (request) => roots.has(request.collection) && demandId(request) === key
            )
        )
            owners.set(consumer.owner.id, consumer.owner);
    return [...owners.values()];
}

export function demandRequests(
    demand: Pick<ReplicationDemand, "objectType" | "query">,
    sources: readonly object[]
) {
    const key = demandId(demand);
    const roots = new Set(sources);
    const requests = new Map<string, CollectionDemandDiagnostic>();
    for (const consumer of queryConsumers())
        for (const request of queryDemandGraph(consumer.collection)) {
            if (!request.requested || !roots.has(request.collection) || demandId(request) !== key) continue;
            try {
                const signature = JSON.stringify(request.requested, (_, value: unknown) =>
                    typeof value === "bigint" ? `${value}n` : value
                );
                requests.set(signature, request);
            } catch {
                /* Nonportable diagnostic values cannot break the inspector. */
            }
        }
    return [...requests.values()];
}
