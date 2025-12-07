import { Client } from "@osdk/client";
import { OntologyObjectsV2, OntologyObjectV2 } from "@osdk/foundry.ontologies";
import { Collection, createCollection, InferSchemaOutput, StandardSchema } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import * as AsyncIterable from "../AsyncIterable.js";
import { convertLoadSubsetFilter, convertLoadSubsetOrderBy } from "./convertLoadSubsetOptions.js";
import { getObjectSetWatcherManager } from "./sync/ObjectSetWatcherManager.js";

export interface CreateObjectsCollectionOpts<T extends StandardSchema<OntologyObjectV2>> {
    client: Client;
    ontologyRid: string;
    objectType: string;
    schema: T;
}

export function createObjectsCollection<T extends StandardSchema<OntologyObjectV2>>({
    client,
    ontologyRid,
    objectType,
    schema,
}: CreateObjectsCollectionOpts<T>): Collection<InferSchemaOutput<T>, string | number> {
    const collectionOptions = queryCollectionOptions({
        queryClient: new QueryClient(),
        getKey: (object) => (object as unknown as { __primaryKey: string | number }).__primaryKey,
        queryKey: ["foundry", objectType],
        syncMode: "on-demand",
        schema,
        queryFn: async (ctx) => {
            const results = await AsyncIterable.toArray(
                AsyncIterable.fromPagination(
                    (pageToken: string | undefined) =>
                        OntologyObjectsV2.search(client, ontologyRid, objectType, {
                            snapshot: true,
                            where: convertLoadSubsetFilter(ctx.meta?.loadSubsetOptions.where),
                            excludeRid: true,
                            // We select all properties right now.
                            select: [],
                            pageToken,
                            orderBy: convertLoadSubsetOrderBy(ctx.meta?.loadSubsetOptions.orderBy),
                        }),
                    (page) => page.nextPageToken,
                    (page) => page.data,
                    ctx.meta?.loadSubsetOptions.limit
                )
            );
            return results as InferSchemaOutput<T>[];
        },
    });
    const collection = createCollection(collectionOptions);

    const objectSetWatcherManager = getObjectSetWatcherManager(client);
    const unsubscribe = objectSetWatcherManager.subscribe({ type: "base", objectType }, (message) => {
        switch (message.type) {
            case "change": {
                collection.utils.writeBatch(() => {
                    for (const update of message.updates) {
                        if (update.type === "object") {
                            switch (update.state) {
                                case "ADDED_OR_UPDATED": {
                                    collection.utils.writeUpsert(update.object as InferSchemaOutput<T>);
                                    break;
                                }
                                case "REMOVED": {
                                    collection.utils.writeDelete(
                                        (update.object as unknown as { __primaryKey: string | number })
                                            .__primaryKey
                                    );
                                    break;
                                }
                            }
                        }
                    }
                });
                break;
            }
            case "refresh": {
                void collection.utils.refetch();
                break;
            }
        }
    });
    collection.on("status:cleaned-up", unsubscribe);

    return collection;
}
