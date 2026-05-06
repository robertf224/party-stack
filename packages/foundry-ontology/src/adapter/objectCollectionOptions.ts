import {
    OntologyObjectsV2,
    OntologyObjectV2,
    type ObjectEditHistoryEntry,
    ObjectTypesV2,
    type ObjectPrimaryKeyV2,
} from "@osdk/foundry.ontologies";
import { getObjectSetWatcherManager } from "@party-stack/foundry-object-set-watcher";
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
import { Store } from "@tanstack/store";
import type { OntologyClient } from "@party-stack/foundry-client";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import {
    convertLoadSubsetFilter,
    convertLoadSubsetOrderBy,
    isAlwaysFalseFilter,
} from "./convertLoadSubsetOptions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

interface OntologyObject extends OntologyObjectV2 {
    __primaryKey: string | number;
}

type FoundryObject = Record<string, unknown>;

const COLLECTION_SYNC_TIMEOUT_MS = 5_000;

class TimeoutWaitingForOperationIdError extends Error {
    constructor(operationId: string, objectType: string) {
        super(`Timed out waiting for Foundry operation ${operationId} to sync for ${objectType}.`);
        this.name = "TimeoutWaitingForOperationIdError";
    }
}

class ObjectCollectionSyncAbortedError extends Error {
    constructor(objectType: string) {
        super(`Foundry sync for ${objectType} stopped before the operation was observed.`);
        this.name = "ObjectCollectionSyncAbortedError";
    }
}

export interface ObjectCollectionUtils extends UtilsRecord {
    awaitOperationId: (operationId: string, timeout?: number) => Promise<boolean>;
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

const geoPointPattern = /^GeoPointPropertyValue\{latitude:\s*(-?[\d.]+),\s*longitude:\s*(-?[\d.]+)\}$/;

function parseGeoPointPropertyValue(value: unknown): { lat: number; lon: number } | undefined {
    if (typeof value !== "string") return undefined;
    const match = geoPointPattern.exec(value);
    if (!match) return undefined;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return undefined;
    return { lat, lon };
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

function isAttachmentPropertyValue(value: unknown): value is { type: "attachment"; attachment: string } {
    return isPlainObject(value) && value.type === "attachment" && typeof value.attachment === "string";
}

function normalizeEditPropertyValue(value: unknown): unknown {
    if (isNullPropertyValue(value)) return undefined;
    const geoPoint = parseGeoPointPropertyValue(value);
    if (geoPoint) return geoPoint;
    if (isWrappedPrimitivePropertyValue(value)) return value.value;
    if (isAttachmentPropertyValue(value)) return { rid: value.attachment };
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
    let where = convertLoadSubsetFilter(opts.where);
    if (isAlwaysFalseFilter(where) || (where?.type === "in" && where.value.length === 0)) {
        return [];
    }

    if (opts.cursor?.whereFrom) {
        const cursorWhere = convertLoadSubsetFilter(opts.cursor.whereFrom);
        if (isAlwaysFalseFilter(cursorWhere)) {
            return [];
        }
        if (cursorWhere) {
            where = where ? { type: "and", value: [where, cursorWhere] } : cursorWhere;
        }
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

function createSyncConfig(
    client: OntologyClient,
    objectType: string,
    primaryKeyProperty: string,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): { sync: SyncConfig<Record<string, unknown>, string | number>; utils: ObjectCollectionUtils } {
    const seenOperationIds = new Store<Set<string>>(new Set<string>());
    const syncDisposed = new Store<boolean>(false);
    let requestEditHistoryCatchUp: (() => void) | undefined;

    const awaitOperationId = async (
        operationId: string,
        timeout: number = COLLECTION_SYNC_TIMEOUT_MS
    ): Promise<boolean> => {
        if (typeof operationId !== "string" || operationId.length === 0) {
            throw new Error("Foundry operationId must be a non-empty string.");
        }

        if (seenOperationIds.state.has(operationId)) {
            return true;
        }

        if (syncDisposed.state) {
            throw new ObjectCollectionSyncAbortedError(objectType);
        }

        requestEditHistoryCatchUp?.();

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeoutId);
                seenOperationIdsSubscription.unsubscribe();
                disposedSubscription.unsubscribe();
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new TimeoutWaitingForOperationIdError(operationId, objectType));
            }, timeout);

            const seenOperationIdsSubscription = seenOperationIds.subscribe(() => {
                if (seenOperationIds.state.has(operationId)) {
                    cleanup();
                    resolve(true);
                }
            });

            const disposedSubscription = syncDisposed.subscribe(() => {
                if (syncDisposed.state) {
                    cleanup();
                    reject(new ObjectCollectionSyncAbortedError(objectType));
                }
            });
        });
    };

    const utils: ObjectCollectionUtils = { awaitOperationId };

    const sync: SyncConfig<Record<string, unknown>, string | number> = {
        sync: (params) => {
            const { begin, write, commit, markReady } = params;

            syncDisposed.setState(() => false);

            const syncedKeys = new Set<string | number>(params.collection.keys());

            let disposed = false;
            const editHistoryCursor = createEditHistoryCursor();
            let catchUpRequested = false;
            let catchUpTask: Promise<void> | undefined;

            const getObjectKey = (object: FoundryObject): string | number =>
                object[primaryKeyProperty] as string | number;

            const upsertObject = (object: FoundryObject) => {
                const key = getObjectKey(object);
                write({ type: syncedKeys.has(key) ? "update" : "insert", value: object });
                syncedKeys.add(key);
            };

            const deleteObjectByKey = (key: string | number): boolean => {
                if (!syncedKeys.has(key)) return false;
                write({ type: "delete", key });
                syncedKeys.delete(key);
                return true;
            };

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
                const pendingMutations = new Map<
                    string | number,
                    { type: "upsert"; object: FoundryObject } | { type: "delete" }
                >();
                const newOperationIds = new Set<string>();

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
                    newOperationIds.add(entry.operationId);

                    const primaryKey = getPrimaryKeyValue(entry.objectPrimaryKey);

                    switch (entry.edit.type) {
                        case "createEdit":
                        case "modifyEdit":
                            pendingMutations.set(primaryKey, {
                                type: "upsert",
                                object: decodeEditProperties(entry.edit.properties, primaryKey),
                            });
                            break;
                        case "deleteEdit":
                            pendingMutations.set(primaryKey, { type: "delete" });
                            break;
                    }
                }

                if (disposed) return;

                let transactionStarted = false;
                for (const [primaryKey, mutation] of pendingMutations) {
                    if (mutation.type === "delete") {
                        if (!syncedKeys.has(primaryKey)) continue;
                    }

                    if (!transactionStarted) {
                        begin({ immediate: true });
                        transactionStarted = true;
                    }

                    if (mutation.type === "delete") {
                        deleteObjectByKey(primaryKey);
                    } else {
                        upsertObject(mutation.object);
                    }
                }

                if (transactionStarted) {
                    commit();
                }

                if (newOperationIds.size > 0) {
                    seenOperationIds.setState((current) => {
                        const next = new Set(current);
                        for (const operationId of newOperationIds) {
                            next.add(operationId);
                        }
                        return next;
                    });
                }
            };

            requestEditHistoryCatchUp = () => {
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
                        if (catchUpRequested && !disposed) {
                            requestEditHistoryCatchUp?.();
                        }
                    });
            };

            const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
                const objects = await fetchFoundryObjects(client, objectType, opts, decodeObject);
                if (objects.length > 0) {
                    begin({ immediate: true });
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
                        requestEditHistoryCatchUp?.();
                        break;
                    }
                    case "refresh": {
                        requestEditHistoryCatchUp?.();
                        break;
                    }
                    case "state": {
                        if (message.status === "open") {
                            requestEditHistoryCatchUp?.();
                        }
                        break;
                    }
                }
            });

            // start task here, cleanup can stop it
            // in that task:
            // - spawn object set subscription, which sends messages to catch up
            // - actions sends messages to catch up

            markReady();

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: () => {
                    disposed = true;
                    requestEditHistoryCatchUp = undefined;
                    syncDisposed.setState(() => true);
                    unsubscribe();
                    loadSubsetDedupe.reset();
                },
            };
        },
    };

    return { sync, utils };
}

// ---------------------------------------------------------------------------
// Collection option types
// ---------------------------------------------------------------------------

export interface ObjectCollectionOpts {
    client: OntologyClient;
    objectType: string;
    primaryKeyProperty: string;
    decodeObject?: (object: Record<string, unknown>) => Record<string, unknown>;
}

export interface ObjectCollectionConfig<TSchema extends StandardSchema<OntologyObject>>
    extends ObjectCollectionOpts,
        Omit<
            CollectionConfig<InferSchemaOutput<TSchema>, string | number, TSchema>,
            "sync" | "syncMode" | "getKey" | "onInsert" | "onUpdate" | "onDelete"
        > {
    schema: TSchema;
}

// ---------------------------------------------------------------------------
// Public collection options
// ---------------------------------------------------------------------------

export function objectCollectionOptions<TSchema extends StandardSchema<OntologyObject>>(
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function objectCollectionOptions(config: any): any {
    const { client, objectType, primaryKeyProperty, decodeObject, schema, ...rest } =
        config as ObjectCollectionOpts & { schema?: StandardSchema<OntologyObject> } & Record<
                string,
                unknown
            >;
    const { sync, utils } = createSyncConfig(client, objectType, primaryKeyProperty, decodeObject);

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
