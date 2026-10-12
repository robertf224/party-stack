import {
    BasicIndex,
    CollectionConfig,
    DeduplicatedLoadSubset,
    InferSchemaOutput,
    LoadSubsetOptions,
    StandardSchema,
    SyncConfig,
    UtilsRecord,
} from "@tanstack/db";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import {
    buildSoqlQuery,
    convertLoadSubsetFilter,
    convertLoadSubsetOrderBy,
    isAlwaysFalseFilter,
    serializeSoqlLiteral,
} from "./convertLoadSubsetOptions.js";
import type {
    SalesforceChangeEvent,
    SalesforceChangeEventSubscription,
    SalesforceChangeEventSubscriptionOptions,
    SalesforceClient,
} from "@party-stack/salesforce-client";

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

type SalesforceObject = Record<string, unknown>;

export type SubscribeToSalesforceChangeEvents = (
    objectType: string,
    listener: (event: SalesforceChangeEvent) => void,
    options?: SalesforceChangeEventSubscriptionOptions
) => Promise<SalesforceChangeEventSubscription>;

export interface ObjectCollectionUtils extends UtilsRecord {
    /**
     * Reset load-subset deduplication and await refetching active subsets.
     */
    invalidate: () => Promise<void>;
    /** Refetch one confirmed backend record and commit it locally. */
    refreshByKey: (key: string | number) => Promise<void>;
    /** Apply a confirmed backend deletion to the local collection. */
    deleteByKey: (key: string | number) => Promise<void>;
}

async function fetchSalesforceObjects(
    client: SalesforceClient,
    objectType: string,
    selectedProperties: string[],
    opts: LoadSubsetOptions,
    decodeObject: (object: SalesforceObject) => SalesforceObject = (object) => object
): Promise<SalesforceObject[]> {
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = opts.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
    if (limit === 0) return [];

    let where = convertLoadSubsetFilter(opts.where);
    if (isAlwaysFalseFilter(where)) {
        return [];
    }

    if (opts.cursor?.whereFrom) {
        const cursorWhere = convertLoadSubsetFilter(opts.cursor.whereFrom);
        if (isAlwaysFalseFilter(cursorWhere)) {
            return [];
        }
        if (cursorWhere?.clause) {
            where = where?.clause
                ? { clause: `(${where.clause} AND ${cursorWhere.clause})`, alwaysFalse: false }
                : cursorWhere;
        }
    }

    // Salesforce OFFSET max is 2000. Prefer locator pagination for deep reads and
    // only push OFFSET when the caller requested a small local window.
    const canPushOffset = offset > 0 && offset <= 2000 && (limit === undefined || offset + limit <= 2000);
    const orderBy = convertLoadSubsetOrderBy(opts.orderBy);
    const soql = buildSoqlQuery({
        objectType,
        selectedProperties,
        where,
        orderBy,
        limit: canPushOffset
            ? limit === undefined
                ? undefined
                : offset + limit
            : limit === undefined
              ? undefined
              : offset + limit,
        offset: canPushOffset ? offset : undefined,
    });

    const results = await AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            async (_pageSize, pageToken: string | undefined) => {
                if (pageToken) {
                    return client.queryMore<SalesforceObject>(pageToken);
                }
                return client.query<SalesforceObject>(soql);
            },
            (page) => (page.done ? undefined : page.nextRecordsUrl),
            (page) => page.records,
            2_000,
            canPushOffset
                ? limit === undefined
                    ? undefined
                    : limit
                : limit === undefined
                  ? undefined
                  : offset + limit
        )
    );

    const sliced = canPushOffset
        ? results
        : results.slice(offset, limit === undefined ? undefined : offset + limit);

    return sliced.map(decodeObject);
}

function createSyncConfig(
    client: SalesforceClient,
    objectType: string,
    primaryKeyProperty: string,
    selectedProperties: string[],
    subscribeToChangeEvents: SubscribeToSalesforceChangeEvents | undefined,
    decodeObject: (object: SalesforceObject) => SalesforceObject = (object) => object
): { sync: SyncConfig<Record<string, unknown>, string | number>; utils: ObjectCollectionUtils } {
    let loadSubsetDedupe: DeduplicatedLoadSubset | undefined;
    let deleteByKey: ((key: string | number) => Promise<void>) | undefined;
    let refreshByKey: ((key: string | number) => Promise<void>) | undefined;
    let invalidate: (() => Promise<void>) | undefined;

    const utils: ObjectCollectionUtils = {
        invalidate: () => {
            if (!invalidate) {
                throw new Error(`Salesforce ${objectType} collection is not ready.`);
            }
            return invalidate();
        },
        refreshByKey: (key) => {
            if (!refreshByKey) {
                throw new Error(`Salesforce ${objectType} collection is not ready.`);
            }
            return refreshByKey(key);
        },
        deleteByKey: (key) => {
            if (!deleteByKey) {
                throw new Error(`Salesforce ${objectType} collection is not ready.`);
            }
            return deleteByKey(key);
        },
    };

    const sync: SyncConfig<Record<string, unknown>, string | number> = {
        sync: (params) => {
            const { begin, write, commit, markError, markReady } = params;
            const activeSubsets = new Set<LoadSubsetOptions>();
            const collectionMetadata = params.metadata?.collection;
            const replayMetadataKey = `salesforce.cdc.${objectType}.replayId`;
            const restoredReplayId = collectionMetadata?.get(replayMetadataKey);
            let disposed = false;
            let changeSubscription: SalesforceChangeEventSubscription | undefined;
            let changeQueue = Promise.resolve();

            const upsertObject = (object: SalesforceObject) => {
                const key = object.Id;
                if (typeof key !== "string" && typeof key !== "number") {
                    throw new Error(
                        `Salesforce object for ${objectType} is missing a string/number Id primary key.`
                    );
                }
                const exists = params.collection.has(key);
                const existing = exists ? params.collection.get(key) : undefined;
                write({
                    type: exists ? "update" : "insert",
                    value: existing ? { ...existing, ...object } : object,
                });
            };

            const loadSubset = async (opts: LoadSubsetOptions, awaitApplication = true): Promise<void> => {
                if (!activeSubsets.has(opts)) {
                    activeSubsets.add(opts);
                    opts.signal?.addEventListener("abort", () => activeSubsets.delete(opts), { once: true });
                }
                const objects = await fetchSalesforceObjects(
                    client,
                    objectType,
                    selectedProperties,
                    opts,
                    decodeObject
                );
                if (objects.length > 0) {
                    begin();
                    for (const object of objects) {
                        upsertObject(object);
                    }
                    const applied = commit();
                    if (applied instanceof Promise) {
                        if (awaitApplication) {
                            await applied;
                        } else {
                            void applied.catch((error) => {
                                if (!disposed) {
                                    markError(error);
                                }
                            });
                        }
                    }
                }
            };

            loadSubsetDedupe = new DeduplicatedLoadSubset({
                loadSubset: (options) => loadSubset(options),
            });
            invalidate = async () => {
                loadSubsetDedupe?.reset();
                for (const subset of activeSubsets) {
                    if (!subset.signal?.aborted) {
                        await loadSubset(subset, false);
                    }
                }
            };
            refreshByKey = async (key) => {
                const result = await client.query<SalesforceObject>(
                    buildSoqlQuery({
                        objectType,
                        selectedProperties,
                        where: {
                            clause: `${primaryKeyProperty} = ${serializeSoqlLiteral(key)}`,
                            alwaysFalse: false,
                        },
                        limit: 1,
                    })
                );
                const object = result.records[0];
                if (!object) {
                    throw new Error(
                        `Salesforce ${objectType} record "${key}" was not returned after a confirmed write.`
                    );
                }
                begin();
                upsertObject(decodeObject(object));
                const applied = commit();
                if (applied instanceof Promise) {
                    void applied.catch((error) => {
                        if (!disposed) {
                            markError(error);
                        }
                    });
                }
                loadSubsetDedupe?.reset();
            };
            deleteByKey = (key) => {
                begin();
                write({
                    type: "delete",
                    key,
                });
                const applied = commit();
                if (applied instanceof Promise) {
                    void applied.catch((error) => {
                        if (!disposed) {
                            markError(error);
                        }
                    });
                }
                loadSubsetDedupe?.reset();
                return Promise.resolve();
            };
            markReady();
            if (subscribeToChangeEvents) {
                void subscribeToChangeEvents(
                    objectType,
                    (event) => {
                        changeQueue = changeQueue
                            .then(async () => {
                                if (disposed) return;
                                const header = event.payload.ChangeEventHeader;
                                if (header.changeType === "DELETE") {
                                    begin();
                                    for (const id of header.recordIds) {
                                        write({
                                            type: "delete",
                                            key: id,
                                        });
                                    }
                                    const replayId = event.event?.replayId;
                                    if (replayId !== undefined) {
                                        collectionMetadata?.set(replayMetadataKey, replayId);
                                    }
                                    await commit();
                                    loadSubsetDedupe?.reset();
                                    return;
                                }
                                await invalidate?.();
                                const replayId = event.event?.replayId;
                                if (replayId !== undefined && collectionMetadata) {
                                    begin();
                                    collectionMetadata.set(replayMetadataKey, replayId);
                                    await commit();
                                }
                            })
                            .catch((error: unknown) => {
                                markError(error instanceof Error ? error : new Error(String(error)));
                            });
                    },
                    typeof restoredReplayId === "number"
                        ? {
                              replayId: restoredReplayId,
                          }
                        : undefined
                ).then(
                    (subscription) => {
                        if (disposed) {
                            subscription.unsubscribe();
                        } else {
                            changeSubscription = subscription;
                        }
                    },
                    (error: unknown) => {
                        markError(error instanceof Error ? error : new Error(String(error)));
                    }
                );
            }

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: () => {
                    disposed = true;
                    changeSubscription?.unsubscribe();
                    void changeQueue.finally(() => {
                        loadSubsetDedupe?.reset();
                        loadSubsetDedupe = undefined;
                        invalidate = undefined;
                        refreshByKey = undefined;
                        deleteByKey = undefined;
                    });
                },
            };
        },
    };

    return { sync, utils };
}

export interface ObjectCollectionOpts {
    client: SalesforceClient;
    objectType: string;
    primaryKeyProperty: string;
    selectedProperties: string[];
    subscribeToChangeEvents?: SubscribeToSalesforceChangeEvents;
    decodeObject?: (object: Record<string, unknown>) => Record<string, unknown>;
}

export interface ObjectCollectionConfig<TSchema extends StandardSchema<SalesforceObject>>
    extends
        ObjectCollectionOpts,
        Omit<
            CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema>,
            "sync" | "syncMode" | "getKey" | "onInsert" | "onUpdate" | "onDelete"
        > {
    schema: TSchema;
}

export function objectCollectionOptions<TSchema extends StandardSchema<SalesforceObject>>(
    config: ObjectCollectionConfig<TSchema>
): WithRequired<
    CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema, ObjectCollectionUtils>,
    "schema"
>;
export function objectCollectionOptions(config: ObjectCollectionOpts): {
    syncMode: "on-demand";
    sync: SyncConfig<Record<string, unknown>, string | number>;
    utils: ObjectCollectionUtils;
};
// oxlint-disable-next-line typescript/no-explicit-any
export function objectCollectionOptions(config: any): any {
    const {
        client,
        objectType,
        primaryKeyProperty,
        selectedProperties,
        subscribeToChangeEvents,
        decodeObject,
        schema,
        ...rest
    } = config as ObjectCollectionOpts & { schema?: StandardSchema<SalesforceObject> } & Record<
            string,
            unknown
        >;
    const { sync, utils } = createSyncConfig(
        client,
        objectType,
        primaryKeyProperty,
        selectedProperties,
        subscribeToChangeEvents,
        decodeObject
    );

    if (schema === undefined) {
        return { syncMode: "on-demand" as const, sync, utils };
    }

    return {
        ...rest,
        schema,
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        syncMode: "on-demand" as const,
        getKey: (object: Record<string, unknown>) =>
            (object as Record<string, string | number>)[primaryKeyProperty] as string | number,
        sync,
        utils,
    };
}
