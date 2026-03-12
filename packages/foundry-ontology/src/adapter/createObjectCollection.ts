import { OntologyObjectsV2, OntologyObjectV2 } from "@osdk/foundry.ontologies";
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
import type { OntologyAdapter, OntologyIR } from "@party-stack/ontology";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { OntologyClient } from "../utils/client.js";
import { convertLoadSubsetFilter, convertLoadSubsetOrderBy } from "./convertLoadSubsetOptions.js";
import { createFoundryObjectDecoder } from "./foundryCodec.js";
import { getObjectSetWatcherManager } from "./sync/ObjectSetWatcherManager.js";

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

interface OntologyObject extends OntologyObjectV2 {
    __primaryKey: string | number;
}

type FoundryObject = OntologyObject & Record<string, unknown>;

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

export function createFoundryObjectSyncConfig(
    client: OntologyClient,
    objectType: string,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): SyncConfig<Record<string, unknown>, string | number> {
    return {
        sync: (params) => {
            const { begin, write, commit, markReady, collection } = params;

            const upsertObject = (object: FoundryObject) => {
                const existingObject = collection._state.syncedData.get(object.__primaryKey);
                if (existingObject) {
                    write({ type: "update", value: object, previousValue: existingObject });
                } else {
                    write({ type: "insert", value: object });
                }
            };

            const deleteObject = (object: FoundryObject) => {
                const existingObject = collection._state.syncedData.get(object.__primaryKey);
                if (existingObject) {
                    write({ type: "delete", value: object, previousValue: existingObject });
                }
            };

            const fetchObjects = async (opts: LoadSubsetOptions): Promise<FoundryObject[]> => {
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
                                // We select all properties right now.
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

                return (results as FoundryObject[]).map(decodeObject);
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
                                const object = decodeObject(update.object as FoundryObject);
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
}

export function createFoundryOntologyAdapter(opts: {
    client: OntologyClient;
    ir?: OntologyIR;
}): OntologyAdapter {
    const decoder = opts.ir ? createFoundryObjectDecoder(opts.ir) : null;

    return {
        name: "foundry",
        getSyncConfig: (objectType: string) =>
            createFoundryObjectSyncConfig(opts.client, objectType, (object) =>
                decoder ? (decoder.decodeObject(objectType, object) as FoundryObject) : object
            ),
    };
}

function objectCollectionOptions<TSchema extends StandardSchema<OntologyObject>>(
    config: ObjectCollectionConfig<TSchema>
): WithRequired<
    CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema, ObjectCollectionUtils>,
    "schema"
> {
    const { client, objectType, schema, ...rest } = config;
    const sync = createFoundryObjectSyncConfig(client, objectType) as unknown as SyncConfig<
        InferSchemaOutput<TSchema>,
        string | number
    >;

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
): Collection<InferSchemaOutput<TSchema>, string | number, ObjectCollectionUtils, TSchema>;
export function createObjectCollection<TSchema extends StandardSchema<OntologyObject>>(
    config: ObjectCollectionConfig<TSchema>
): Collection<InferSchemaOutput<TSchema>, string | number, ObjectCollectionUtils, TSchema> {
    return createCollection(objectCollectionOptions(config));
}
