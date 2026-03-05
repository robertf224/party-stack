import { OntologyObjectsV2 } from "@osdk/foundry.ontologies";
import {
    Collection,
    CollectionConfig,
    createCollection,
    DeduplicatedLoadSubset,
    InferSchemaOutput,
    LoadSubsetOptions,
    StandardSchema,
    SyncConfig,
    UtilsRecord,
} from "@tanstack/db";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { OntologyClient } from "../utils/client.js";
import { convertLoadSubsetFilter, convertLoadSubsetOrderBy } from "./convertLoadSubsetOptions.js";
import { OntologyObject } from "./OntologyObject.js";
import { getObjectSetWatcherManager } from "./sync/ObjectSetWatcherManager.js";

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

export interface ObjectCollectionConfig<TSchema extends StandardSchema<OntologyObject>>
    extends Omit<
        CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema>,
        "sync" | "syncMode" | "getKey" | "onInsert" | "onUpdate" | "onDelete"
    > {
    client: OntologyClient;
    objectType: string;
    schema: TSchema;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ObjectCollectionUtils extends UtilsRecord {}

function objectCollectionOptions<TSchema extends StandardSchema<OntologyObject>>(
    config: ObjectCollectionConfig<TSchema>
): WithRequired<
    CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema, ObjectCollectionUtils>,
    "schema"
> {
    const { client, objectType, schema, ...rest } = config;

    const sync: SyncConfig<InferSchemaOutput<TSchema>, string | number> = {
        sync: (params) => {
            const { begin, write, commit, markReady, collection } = params;

            const upsertObject = (object: InferSchemaOutput<TSchema>) => {
                const existingObject = collection._state.syncedData.get(object.__primaryKey);
                if (existingObject) {
                    write({ type: "update", value: object, previousValue: existingObject });
                } else {
                    write({ type: "insert", value: object });
                }
            };

            const deleteObject = (object: InferSchemaOutput<TSchema>) => {
                const existingObject = collection._state.syncedData.get(object.__primaryKey);
                if (existingObject) {
                    write({ type: "delete", value: object, previousValue: existingObject });
                }
            };

            const fetchObjects = async (opts: LoadSubsetOptions): Promise<InferSchemaOutput<TSchema>[]> => {
                const where = convertLoadSubsetFilter(opts.where);

                // Short-circuit this case since it should be no results but Foundry returns everything.
                if (where?.type === "in" && where.value.length === 0) {
                    return [];
                }

                const results = await AsyncIterable.toArray(
                    AsyncIterable.fromPagination(
                        (pageSize, pageToken: string | undefined) =>
                            OntologyObjectsV2.search(client, client.ontologyRid, objectType, {
                                snapshot: true,
                                where,
                                excludeRid: true,
                                // We select all properties right now
                                select: [],
                                selectV2: [],
                                pageSize,
                                pageToken,
                                orderBy: convertLoadSubsetOrderBy(opts.orderBy),
                            }),
                        (page) => page.nextPageToken,
                        (page) => page.data,
                        10_000,
                        opts.limit
                    )
                );

                return results as InferSchemaOutput<TSchema>[];
            };
            const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
                const objects = await fetchObjects(opts);
                if (objects.length > 0) {
                    begin();
                    for (const object of objects) {
                        upsertObject(object);
                    }
                    commit();
                }
            };
            const loadSubsetDedupe = new DeduplicatedLoadSubset({ loadSubset });

            const objectSetWatcherManager = getObjectSetWatcherManager(client);
            const unsubscribe = objectSetWatcherManager.subscribe({ type: "base", objectType }, (message) => {
                switch (message.type) {
                    case "change": {
                        begin();
                        for (const update of message.updates) {
                            if (update.type === "object") {
                                const object = update.object as InferSchemaOutput<TSchema>;
                                switch (update.state) {
                                    case "ADDED_OR_UPDATED": {
                                        upsertObject(object);
                                        break;
                                    }
                                    case "REMOVED": {
                                        deleteObject(object);
                                        break;
                                    }
                                }
                            }
                        }
                        commit();
                        break;
                    }
                    case "refresh": {
                        loadSubsetDedupe.reset();
                        break;
                    }
                }
            });

            markReady();

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: unsubscribe,
            };
        },
    };

    return {
        ...rest,
        schema,
        syncMode: "on-demand",
        getKey: (object) => object.__primaryKey,
        sync,
    };
}

export function createObjectCollection<TSchema extends StandardSchema<OntologyObject>>(
    config: ObjectCollectionConfig<TSchema>
): Collection<InferSchemaOutput<TSchema>, string | number, ObjectCollectionUtils, TSchema> {
    return createCollection(objectCollectionOptions(config));
}
