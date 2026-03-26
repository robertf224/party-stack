import {
    OntologyObjectsV2,
    OntologyObjectV2,
    type ObjectEditHistoryEntry,
    ObjectTypesV2,
    type ObjectPrimaryKeyV2,
} from "@osdk/foundry.ontologies";
import {
    BasicIndex,
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
import { Store } from "@tanstack/store";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { OntologyClient } from "../utils/client.js";
import { convertLoadSubsetFilter, convertLoadSubsetOrderBy } from "./convertLoadSubsetOptions.js";
import { getObjectSetWatcherManager } from "./sync/ObjectSetWatcherManager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

interface OntologyObject extends OntologyObjectV2 {
    __primaryKey: string | number;
}

type FoundryObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Sync tracking types
// ---------------------------------------------------------------------------

const COLLECTION_SYNC_TIMEOUT_MS = 5_000;

export type CollectionSyncEvent = "upsert" | "delete";

type SyncEntry = { version: number; event: CollectionSyncEvent };

export interface ObjectCollectionUtils extends UtilsRecord {
    getObjectSyncVersion: (key: string | number) => number;
    awaitObjectSync: (
        key: string | number,
        opts: { event: CollectionSyncEvent; afterVersion: number; timeout?: number }
    ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Edit history helpers
// ---------------------------------------------------------------------------

const EDIT_HISTORY_PAGE_SIZE = 1_000;

interface EditHistoryCursor {
    timestamp: string;
    seenEntryKeysAtTimestamp: Set<string>;
}

function createEditHistoryCursor(timestamp: string = new Date().toISOString()): EditHistoryCursor {
    return { timestamp, seenEntryKeysAtTimestamp: new Set() };
}

function getEditHistoryEntryKey(entry: ObjectEditHistoryEntry): string {
    return JSON.stringify({
        objectPrimaryKey: entry.objectPrimaryKey,
        operationId: entry.operationId,
        timestamp: entry.timestamp,
        edit: entry.edit,
    });
}

function shouldProcessEditHistoryEntry(cursor: EditHistoryCursor, entry: ObjectEditHistoryEntry): boolean {
    if (entry.timestamp < cursor.timestamp) return false;
    if (entry.timestamp === cursor.timestamp) {
        return !cursor.seenEntryKeysAtTimestamp.has(getEditHistoryEntryKey(entry));
    }
    return true;
}

function advanceEditHistoryCursor(cursor: EditHistoryCursor, entry: ObjectEditHistoryEntry): void {
    const entryKey = getEditHistoryEntryKey(entry);
    if (entry.timestamp > cursor.timestamp) {
        cursor.timestamp = entry.timestamp;
        cursor.seenEntryKeysAtTimestamp.clear();
    }
    cursor.seenEntryKeysAtTimestamp.add(entryKey);
}

function getPrimaryKeyValue(primaryKey: ObjectPrimaryKeyV2): string | number {
    const values = Object.values(primaryKey);
    if (values.length !== 1) {
        throw new Error("Foundry object collections currently only support single-field primary keys.");
    }
    const value = normalizeEditPropertyValue(values[0]);
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error("Foundry object collections currently only support string or number primary keys.");
    }
    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullPropertyValue(value: unknown): boolean {
    return value === "NullPropertyValue{}";
}

function isWrappedPrimitivePropertyValue(
    value: unknown
): value is { type: string; value: string | number | boolean } {
    if (!isPlainObject(value) || typeof value.type !== "string" || !("value" in value)) {
        return false;
    }
    return [
        "stringValue",
        "integerValue",
        "doubleValue",
        "longValue",
        "booleanValue",
        "dateValue",
        "timestampValue",
    ].includes(value.type);
}

function normalizeEditPropertyValue(value: unknown): unknown {
    if (isNullPropertyValue(value)) return undefined;
    if (isWrappedPrimitivePropertyValue(value)) return value.value;
    if (Array.isArray(value)) return value.map(normalizeEditPropertyValue);
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, v]) => [key, normalizeEditPropertyValue(v)])
        );
    }
    return value;
}

// ---------------------------------------------------------------------------
// Foundry object fetching
// ---------------------------------------------------------------------------

async function fetchFoundryObjects(
    client: OntologyClient,
    objectType: string,
    opts: LoadSubsetOptions,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): Promise<FoundryObject[]> {
    const where = convertLoadSubsetFilter(opts.where);
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
}

// ---------------------------------------------------------------------------
// Sync config + utils factory
//
// Follows Electric's pattern: the Store is created in the factory closure and
// shared by both the sync function and the utils via lexical scope.
// No WeakMap, no lazy binding — just closures, like electricCollectionOptions.
// ---------------------------------------------------------------------------

export function createFoundryObjectSyncConfig(
    client: OntologyClient,
    objectType: string,
    primaryKeyProperty: string,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): { sync: SyncConfig<Record<string, unknown>, string | number>; utils: ObjectCollectionUtils } {
    // Shared Store for sync tracking — like Electric's seenTxids Store.
    // Both the sync function and the utils close over this same instance.
    const syncStore = new Store<Map<string | number, SyncEntry>>(new Map());

    const recordSyncEvent = (key: string | number, event: CollectionSyncEvent): void => {
        syncStore.setState((prev) => {
            const next = new Map(prev);
            const current = next.get(key);
            next.set(key, { version: (current?.version ?? 0) + 1, event });
            return next;
        });
    };

    // -- utils (like Electric's awaitTxId / awaitMatch) -----------------------

    const getObjectSyncVersion = (key: string | number): number =>
        syncStore.state.get(key)?.version ?? 0;

    const awaitObjectSync = (
        key: string | number,
        opts: { event: CollectionSyncEvent; afterVersion: number; timeout?: number }
    ): Promise<void> => {
        const isSatisfied = () => {
            const entry = syncStore.state.get(key);
            return entry !== undefined && entry.version > opts.afterVersion && entry.event === opts.event;
        };

        if (isSatisfied()) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            const timeout = opts.timeout ?? COLLECTION_SYNC_TIMEOUT_MS;

            const timeoutId = setTimeout(() => {
                subscription.unsubscribe();
                resolve();
            }, timeout);

            const subscription = syncStore.subscribe(() => {
                if (isSatisfied()) {
                    clearTimeout(timeoutId);
                    subscription.unsubscribe();
                    resolve();
                }
            });
        });
    };

    const utils: ObjectCollectionUtils = { getObjectSyncVersion, awaitObjectSync };

    // -- sync -----------------------------------------------------------------

    const sync: SyncConfig<Record<string, unknown>, string | number> = {
        sync: (params) => {
            const { begin, write, commit, markReady } = params;

            const syncedKeys = new Set<string | number>();

            let disposed = false;
            const editHistoryCursor = createEditHistoryCursor();
            let catchUpRequested = false;
            let catchUpTask: Promise<void> | undefined;
            let scheduledCatchUpRetry: ReturnType<typeof setTimeout> | undefined;

            // -- key extraction -----------------------------------------------

            const getObjectKey = (object: FoundryObject): string | number =>
                object[primaryKeyProperty] as string | number;

            // -- write helpers ------------------------------------------------

            const upsertObject = (object: FoundryObject) => {
                const key = getObjectKey(object);
                write({ type: syncedKeys.has(key) ? "update" : "insert", value: object });
                syncedKeys.add(key);
            };

            const deleteObject = (object: FoundryObject): boolean => {
                const key = getObjectKey(object);
                if (!syncedKeys.has(key)) return false;
                write({ type: "delete", value: object });
                syncedKeys.delete(key);
                return true;
            };

            // -- edit history -------------------------------------------------

            const fetchEditHistoryPage = (body: Parameters<typeof ObjectTypesV2.getEditsHistory>[3]) =>
                ObjectTypesV2.getEditsHistory(
                    client,
                    client.ontologyRid,
                    objectType,
                    body,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                    {
                        preview: true,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as unknown as any
                );

            const decodeEditProperties = (
                properties: Record<string, unknown>,
                primaryKey: string | number
            ): FoundryObject =>
                decodeObject({
                    ...Object.fromEntries(
                        Object.entries(properties).map(([key, value]) => [
                            key,
                            normalizeEditPropertyValue(value),
                        ])
                    ),
                    [primaryKeyProperty]: primaryKey,
                } as FoundryObject);

            const catchUpFromEditHistory = async (): Promise<void> => {
                const pendingUpserts = new Map<string | number, FoundryObject>();

                for await (const entry of AsyncIterable.fromPagination(
                    (pageSize, pageToken: string | undefined) =>
                        fetchEditHistoryPage({
                            filters: {
                                type: "timestampFilter",
                                startTime: editHistoryCursor.timestamp,
                            },
                            includeAllPreviousProperties: true,
                            pageSize,
                            pageToken,
                            sortOrder: "oldest_first",
                        }),
                    (page) => page.nextPageToken,
                    (page) => page.data,
                    EDIT_HISTORY_PAGE_SIZE
                )) {
                    if (disposed) break;
                    if (!shouldProcessEditHistoryEntry(editHistoryCursor, entry)) continue;
                    advanceEditHistoryCursor(editHistoryCursor, entry);

                    const primaryKey = getPrimaryKeyValue(entry.objectPrimaryKey);

                    switch (entry.edit.type) {
                        case "createEdit":
                        case "modifyEdit":
                            pendingUpserts.set(
                                primaryKey,
                                decodeEditProperties(entry.edit.properties, primaryKey)
                            );
                            break;
                        case "deleteEdit":
                            break;
                    }
                }

                if (disposed || pendingUpserts.size === 0) return;

                begin({ immediate: true });
                for (const object of pendingUpserts.values()) {
                    upsertObject(object);
                }
                commit();

                for (const key of pendingUpserts.keys()) {
                    recordSyncEvent(key, "upsert");
                }
            };

            const requestEditHistoryCatchUp = () => {
                if (scheduledCatchUpRetry) {
                    clearTimeout(scheduledCatchUpRetry);
                    scheduledCatchUpRetry = undefined;
                }

                catchUpRequested = true;
                if (catchUpTask) return;

                catchUpTask = (async () => {
                    while (catchUpRequested && !disposed) {
                        catchUpRequested = false;
                        await catchUpFromEditHistory();
                    }
                })()
                    .catch((error: unknown) => {
                        console.error("Error during edit history catch-up", error);
                    })
                    .finally(() => {
                        catchUpTask = undefined;
                        if (catchUpRequested && !disposed) requestEditHistoryCatchUp();
                    });
            };

            // -- loadSubset ---------------------------------------------------

            const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
                const objects = await fetchFoundryObjects(client, objectType, opts, decodeObject);
                if (objects.length > 0) {
                    begin({ immediate: true });
                    for (const object of objects) {
                        upsertObject(object);
                    }
                    commit();
                    for (const object of objects) {
                        recordSyncEvent(getObjectKey(object), "upsert");
                    }
                }
            };

            // -- watcher subscription -----------------------------------------

            const loadSubsetDedupe = new DeduplicatedLoadSubset({ loadSubset });
            const objectSetWatcherManager = getObjectSetWatcherManager(client);
            const unsubscribe = objectSetWatcherManager.subscribe(
                { type: "base", objectType },
                (message) => {
                    switch (message.type) {
                        case "change": {
                            let shouldCatchUp = false;
                            const removedObjects: FoundryObject[] = [];

                            for (const update of message.updates) {
                                if (update.type === "object") {
                                    switch (update.state) {
                                        case "ADDED_OR_UPDATED":
                                            shouldCatchUp = true;
                                            break;
                                        case "REMOVED":
                                            removedObjects.push(
                                                decodeObject(update.object as FoundryObject)
                                            );
                                            break;
                                    }
                                }
                            }

                            if (removedObjects.length > 0) {
                                const deletedKeys: Array<string | number> = [];
                                begin({ immediate: true });
                                for (const object of removedObjects) {
                                    if (deleteObject(object)) {
                                        deletedKeys.push(getObjectKey(object));
                                    }
                                }
                                commit();
                                for (const key of deletedKeys) {
                                    recordSyncEvent(key, "delete");
                                }
                            }

                            if (shouldCatchUp) {
                                requestEditHistoryCatchUp();
                            }
                            break;
                        }
                        case "refresh": {
                            loadSubsetDedupe.reset();
                            requestEditHistoryCatchUp();
                            break;
                        }
                        case "state": {
                            if (message.status === "open") {
                                requestEditHistoryCatchUp();
                            }
                            break;
                        }
                    }
                }
            );

            markReady();

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: () => {
                    disposed = true;
                    if (scheduledCatchUpRetry) {
                        clearTimeout(scheduledCatchUpRetry);
                    }
                    unsubscribe();
                },
            };
        },
    };

    return { sync, utils };
}

// ---------------------------------------------------------------------------
// Collection config types
// ---------------------------------------------------------------------------

export interface ObjectCollectionConfig<TSchema extends StandardSchema<OntologyObject>>
    extends Omit<
        CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema>,
        "sync" | "syncMode" | "getKey" | "onInsert" | "onUpdate" | "onDelete"
    > {
    client: OntologyClient;
    objectType: string;
    primaryKeyProperty: string;
    schema: TSchema;
}

// ---------------------------------------------------------------------------
// Public collection creation
// ---------------------------------------------------------------------------

function objectCollectionOptions<TSchema extends StandardSchema<OntologyObject>>(
    config: ObjectCollectionConfig<TSchema>
): WithRequired<
    CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema, ObjectCollectionUtils>,
    "schema"
> {
    const { client, objectType, primaryKeyProperty, schema, ...rest } = config;
    const { sync: syncConfig, utils } = createFoundryObjectSyncConfig(client, objectType, primaryKeyProperty);
    const sync = syncConfig as unknown as SyncConfig<InferSchemaOutput<TSchema>, string | number>;

    return {
        ...rest,
        schema,
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        syncMode: "on-demand",
        getKey: (object) =>
            (object as Record<string, string | number>)[primaryKeyProperty] as string | number,
        sync,
        utils,
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
