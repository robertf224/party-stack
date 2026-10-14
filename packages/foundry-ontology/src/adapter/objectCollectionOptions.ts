import {
    OntologyObjectsV2,
    OntologyObjectV2,
    type ObjectEditHistoryEntry,
    type ObjectSetUpdate,
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
import * as AsyncIterable from "../utils/AsyncIterable.js";
import {
    convertLoadSubsetFilter,
    convertLoadSubsetOrderBy,
    isAlwaysFalseFilter,
} from "./convertLoadSubsetOptions.js";
import type { OntologyClient } from "@party-stack/foundry-client";

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
    refresh: () => Promise<void>;
    awaitOperationId: (operationId: string, timeout?: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Edit history helpers
// ---------------------------------------------------------------------------

const EDIT_HISTORY_PAGE_SIZE = 1_000;
const EDIT_HISTORY_CURSOR_METADATA_KEY = "foundry.editHistoryCursor";
const EDIT_HISTORY_CURSOR_VERSION = 1;

interface EditHistoryCursor {
    timestamp: string;
    seenEntryKeysAtTimestamp: Set<string>;
}

interface PersistedEditHistoryCursor {
    version: typeof EDIT_HISTORY_CURSOR_VERSION;
    timestamp: string;
    seenEntryKeysAtTimestamp: string[];
}

function createEditHistoryCursor(timestamp: string = new Date().toISOString()): EditHistoryCursor {
    return { timestamp, seenEntryKeysAtTimestamp: new Set() };
}

function cloneEditHistoryCursor(cursor: EditHistoryCursor): EditHistoryCursor {
    return {
        timestamp: cursor.timestamp,
        seenEntryKeysAtTimestamp: new Set(cursor.seenEntryKeysAtTimestamp),
    };
}

function serializeEditHistoryCursor(cursor: EditHistoryCursor): PersistedEditHistoryCursor {
    return {
        version: EDIT_HISTORY_CURSOR_VERSION,
        timestamp: cursor.timestamp,
        seenEntryKeysAtTimestamp: [...cursor.seenEntryKeysAtTimestamp].sort(),
    };
}

function deserializeEditHistoryCursor(value: unknown): EditHistoryCursor | undefined {
    if (
        !isPlainObject(value) ||
        value.version !== EDIT_HISTORY_CURSOR_VERSION ||
        typeof value.timestamp !== "string" ||
        !Array.isArray(value.seenEntryKeysAtTimestamp) ||
        !value.seenEntryKeysAtTimestamp.every((key) => typeof key === "string")
    ) {
        return undefined;
    }
    return {
        timestamp: value.timestamp,
        seenEntryKeysAtTimestamp: new Set(value.seenEntryKeysAtTimestamp),
    };
}

function editHistoryCursorsEqual(left: EditHistoryCursor, right: EditHistoryCursor): boolean {
    return (
        left.timestamp === right.timestamp &&
        left.seenEntryKeysAtTimestamp.size === right.seenEntryKeysAtTimestamp.size &&
        [...left.seenEntryKeysAtTimestamp].every((key) => right.seenEntryKeysAtTimestamp.has(key))
    );
}

function canonicalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalizeJsonValue(value[key])])
        );
    }
    return value;
}

function getEditHistoryEntryKey(entry: ObjectEditHistoryEntry): string {
    return JSON.stringify(
        canonicalizeJsonValue({
            objectPrimaryKey: entry.objectPrimaryKey,
            operationId: entry.operationId,
            timestamp: entry.timestamp,
            edit: entry.edit,
        })
    );
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

function getPrimaryKeyValue(
    primaryKey: ObjectPrimaryKeyV2,
    primaryKeyProperty: string,
    decodeEditObject: (object: FoundryObject) => FoundryObject
): string | number {
    const values = Object.values(primaryKey);
    if (values.length !== 1) {
        throw new Error("Foundry object collections currently only support single-field primary keys.");
    }
    const value = decodeEditObject({
        [primaryKeyProperty]: values[0],
    })[primaryKeyProperty];
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error("Foundry object collections currently only support string or number primary keys.");
    }
    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Foundry object fetching
// ---------------------------------------------------------------------------

async function fetchFoundryObjects(
    client: OntologyClient,
    objectType: string,
    selectedProperties: string[],
    opts: LoadSubsetOptions,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): Promise<FoundryObject[]> {
    opts.signal?.throwIfAborted();
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = opts.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
    if (limit === 0) return [];

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

    const requestClient = opts.signal
        ? {
              ...client,
              fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                  client.fetch(input, {
                      ...init,
                      signal: opts.signal,
                  }),
          }
        : client;
    const results = await AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                OntologyObjectsV2.search(requestClient, client.ontologyRid, objectType, {
                    snapshot: true,
                    where,
                    excludeRid: true,
                    select: selectedProperties,
                    selectV2: [],
                    pageSize,
                    pageToken,
                    orderBy: convertLoadSubsetOrderBy(opts.orderBy),
                }),
            (page) => page.nextPageToken,
            (page) => page.data,
            10_000,
            limit === undefined ? undefined : offset + limit
        )
    );
    opts.signal?.throwIfAborted();

    return (results as FoundryObject[])
        .slice(offset, limit === undefined ? undefined : offset + limit)
        .map(decodeObject);
}

function createSyncConfig(
    client: OntologyClient,
    objectType: string,
    primaryKeyProperty: string,
    selectedProperties: string[],
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object,
    decodeEditObject: (object: FoundryObject) => FoundryObject = decodeObject,
    live: boolean = true
): { sync: SyncConfig<Record<string, unknown>, string | number>; utils: ObjectCollectionUtils } {
    const seenOperationIds = new Store<Set<string>>(new Set<string>());
    const syncDisposed = new Store(false);
    const fullSourceRefreshVersion = new Store(0);
    let editHistoryUnavailable = false;
    let requestFullRefresh: (() => Promise<void>) | undefined;
    const refresh = async (): Promise<void> => {
        if (!requestFullRefresh || syncDisposed.state) throw new ObjectCollectionSyncAbortedError(objectType);
        await requestFullRefresh();
    };
    const refreshInBackground = () => {
        void refresh().catch((error: unknown) => {
            console.warn(`Failed full Foundry refresh for ${objectType}.`, error);
        });
    };
    let requestEditHistoryCatchUp: (() => void) | undefined;

    const awaitOperationId = async (
        operationId: string,
        timeout: number = COLLECTION_SYNC_TIMEOUT_MS
    ): Promise<void> => {
        if (typeof operationId !== "string" || operationId.length === 0) {
            throw new Error("Foundry operationId must be a non-empty string.");
        }

        if (seenOperationIds.state.has(operationId)) {
            return;
        }

        if (syncDisposed.state) {
            throw new ObjectCollectionSyncAbortedError(objectType);
        }

        if (!requestEditHistoryCatchUp) {
            // An on-demand collection has no local state to confirm until its sync starts.
            return;
        }

        const refreshVersionAtStart = fullSourceRefreshVersion.state;
        const historyUnavailableAtStart = editHistoryUnavailable;
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeoutId);
                seenOperationIdsSubscription.unsubscribe();
                fullSourceRefreshVersionSubscription.unsubscribe();
                disposedSubscription.unsubscribe();
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new TimeoutWaitingForOperationIdError(operationId, objectType));
            }, timeout);
            const seenOperationIdsSubscription = seenOperationIds.subscribe(() => {
                if (seenOperationIds.state.has(operationId)) {
                    cleanup();
                    resolve();
                }
            });
            const fullSourceRefreshVersionSubscription = fullSourceRefreshVersion.subscribe(() => {
                if (
                    !historyUnavailableAtStart &&
                    editHistoryUnavailable &&
                    fullSourceRefreshVersion.state > refreshVersionAtStart
                ) {
                    cleanup();
                    resolve();
                }
            });
            const disposedSubscription = syncDisposed.subscribe(() => {
                if (syncDisposed.state) {
                    cleanup();
                    reject(new ObjectCollectionSyncAbortedError(objectType));
                }
            });
            if (editHistoryUnavailable) {
                void refresh().then(
                    () => {
                        cleanup();
                        resolve();
                    },
                    (error: unknown) => {
                        cleanup();
                        reject(error);
                    }
                );
            } else requestEditHistoryCatchUp?.();
        });
    };

    const utils: ObjectCollectionUtils = { awaitOperationId, refresh };

    const sync: SyncConfig<Record<string, unknown>, string | number> = {
        sync: (params) => {
            const { begin, write, commit, markError, markReady, truncate } = params;
            const collectionMetadata = params.metadata?.collection;

            syncDisposed.setState(() => false);

            let disposed = false;
            const restoredEditHistoryCursor = deserializeEditHistoryCursor(
                collectionMetadata?.get(EDIT_HISTORY_CURSOR_METADATA_KEY)
            );
            let editHistoryCursor = restoredEditHistoryCursor ?? createEditHistoryCursor();
            let initialCommit: ReturnType<typeof commit> = true;
            if (!restoredEditHistoryCursor) {
                if (collectionMetadata) {
                    begin();
                    collectionMetadata.set(
                        EDIT_HISTORY_CURSOR_METADATA_KEY,
                        serializeEditHistoryCursor(editHistoryCursor)
                    );
                    initialCommit = commit();
                }
            }
            let catchUpRequested = false;
            let catchUpTask: Promise<void> | undefined;
            let pendingDirectWatcherUpdates: ObjectSetUpdate[] = [];
            let fullRefreshRequested = false;
            let fullRefreshTask: Promise<void> | undefined;

            const getObjectKey = (object: FoundryObject): string | number =>
                object[primaryKeyProperty] as string | number;

            const getWatcherObjectKey = (object: FoundryObject): string | number => {
                const key = object[primaryKeyProperty] ?? object.__primaryKey;
                if (typeof key !== "string" && typeof key !== "number") {
                    throw new Error(
                        `Foundry websocket update for ${objectType} did not include a supported primary key.`
                    );
                }
                return key;
            };

            const upsertObject = (object: FoundryObject) => {
                const key = getObjectKey(object);
                const exists = params.collection.has(key);
                const existing = exists ? params.collection.get(key) : undefined;
                write({
                    type: exists ? "update" : "insert",
                    value: existing
                        ? {
                              ...existing,
                              ...object,
                          }
                        : object,
                });
            };

            const deleteObjectByKey = (key: string | number): boolean => {
                write({ type: "delete", key });
                return true;
            };

            const fetchEditHistoryPage = (body: Parameters<typeof ObjectTypesV2.getEditsHistory>[3]) =>
                ObjectTypesV2.getEditsHistory(
                    client,
                    client.ontologyRid,
                    objectType,
                    body,
                    // oxlint-disable-next-line typescript/no-unsafe-argument
                    {
                        preview: true,
                        // oxlint-disable-next-line typescript/no-explicit-any
                    } as unknown as any
                );

            const decodeEditProperties = (
                properties: Record<string, unknown>,
                primaryKey: string | number
            ): FoundryObject =>
                decodeEditObject({
                    ...properties,
                    [primaryKeyProperty]: primaryKey,
                });

            const decodeWatcherObject = (object: FoundryObject, primaryKey: string | number): FoundryObject =>
                decodeObject({
                    ...object,
                    [primaryKeyProperty]: primaryKey,
                });

            const applyDirectWatcherUpdates = async (updates: ObjectSetUpdate[]): Promise<void> => {
                const pendingMutations = new Map<
                    string | number,
                    { type: "upsert"; object: FoundryObject } | { type: "delete" }
                >();

                for (const update of updates) {
                    if (update.type !== "object") continue;

                    const object = update.object;
                    const primaryKey = getWatcherObjectKey(object);

                    switch (update.state) {
                        case "ADDED_OR_UPDATED":
                            pendingMutations.set(primaryKey, {
                                type: "upsert",
                                object: decodeWatcherObject(object, primaryKey),
                            });
                            break;
                        case "REMOVED":
                            pendingMutations.set(primaryKey, { type: "delete" });
                            break;
                    }
                }

                let transactionStarted = false;
                for (const [primaryKey, mutation] of pendingMutations) {
                    if (!transactionStarted) {
                        begin();
                        transactionStarted = true;
                    }

                    if (mutation.type === "delete") {
                        deleteObjectByKey(primaryKey);
                    } else {
                        upsertObject(mutation.object);
                    }
                }

                const receipt = transactionStarted ? commit() : true;

                if (receipt !== true) await receipt;
            };

            const switchToDirectWebsocketMode = (error: unknown): void => {
                if (!editHistoryUnavailable) {
                    const errorMessage = error instanceof Error ? error.message : error;
                    console.warn(
                        `Edit history catch-up failed for ${objectType}; falling back to direct websocket updates.`,
                        errorMessage
                    );
                    editHistoryUnavailable = true;
                }

                if (pendingDirectWatcherUpdates.length > 0) {
                    const updates = pendingDirectWatcherUpdates;
                    pendingDirectWatcherUpdates = [];
                    void applyDirectWatcherUpdates(updates).catch((applyError: unknown) => {
                        console.warn(`Failed to apply direct Foundry updates for ${objectType}.`, applyError);
                    });
                }
                refreshInBackground();
            };

            const catchUpFromEditHistory = async (): Promise<void> => {
                const nextEditHistoryCursor = cloneEditHistoryCursor(editHistoryCursor);
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
                                startTime: nextEditHistoryCursor.timestamp,
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
                    if (!shouldProcessEditHistoryEntry(nextEditHistoryCursor, entry)) continue;
                    advanceEditHistoryCursor(nextEditHistoryCursor, entry);
                    newOperationIds.add(entry.operationId);

                    const primaryKey = getPrimaryKeyValue(
                        entry.objectPrimaryKey,
                        primaryKeyProperty,
                        decodeEditObject
                    );

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

                const checkpointChanged = !editHistoryCursorsEqual(editHistoryCursor, nextEditHistoryCursor);
                let transactionStarted = false;
                const ensureTransaction = () => {
                    if (transactionStarted) return;
                    begin();
                    transactionStarted = true;
                };
                for (const [primaryKey, mutation] of pendingMutations) {
                    ensureTransaction();

                    if (mutation.type === "delete") {
                        deleteObjectByKey(primaryKey);
                    } else {
                        upsertObject(mutation.object);
                    }
                }

                if (checkpointChanged && collectionMetadata) {
                    ensureTransaction();
                    collectionMetadata.set(
                        EDIT_HISTORY_CURSOR_METADATA_KEY,
                        serializeEditHistoryCursor(nextEditHistoryCursor)
                    );
                }

                const receipt = transactionStarted ? commit() : true;

                if (checkpointChanged) {
                    editHistoryCursor = nextEditHistoryCursor;
                }

                if (newOperationIds.size > 0) {
                    seenOperationIds.setState((current) => new Set([...current, ...newOperationIds]));
                }

                pendingDirectWatcherUpdates = [];

                if (receipt !== true) await receipt;
            };

            const refreshAllFromSource = async (): Promise<void> => {
                const objects = await fetchFoundryObjects(
                    client,
                    objectType,
                    selectedProperties,
                    {},
                    decodeObject
                );
                if (disposed) throw new ObjectCollectionSyncAbortedError(objectType);

                begin();
                truncate();
                for (const object of objects) {
                    write({
                        type: "insert",
                        value: object,
                    });
                }
                const receipt = commit();

                if (receipt !== true) await receipt;
                if (disposed) throw new ObjectCollectionSyncAbortedError(objectType);
                while (pendingDirectWatcherUpdates.length > 0 && !disposed) {
                    const updates = pendingDirectWatcherUpdates;
                    pendingDirectWatcherUpdates = [];
                    await applyDirectWatcherUpdates(updates);
                }
                if (disposed) throw new ObjectCollectionSyncAbortedError(objectType);
                fullSourceRefreshVersion.setState((version) => version + 1);
            };

            requestFullRefresh = () => {
                fullRefreshRequested = true;
                if (fullRefreshTask) return fullRefreshTask;

                const priorCatchUp = catchUpTask;
                fullRefreshTask = (async () => {
                    if (priorCatchUp) await priorCatchUp;
                    if (disposed) throw new ObjectCollectionSyncAbortedError(objectType);
                    while (fullRefreshRequested && !disposed) {
                        fullRefreshRequested = false;
                        await refreshAllFromSource();
                    }
                })()
                    .catch(async (error: unknown) => {
                        // A failed snapshot must not strand updates queued by the live watcher.
                        while (pendingDirectWatcherUpdates.length > 0 && !disposed) {
                            const updates = pendingDirectWatcherUpdates;
                            pendingDirectWatcherUpdates = [];
                            try {
                                await applyDirectWatcherUpdates(updates);
                            } catch (applyError: unknown) {
                                console.warn(
                                    `Failed to apply queued Foundry updates for ${objectType}.`,
                                    applyError
                                );
                                break;
                            }
                        }
                        throw error;
                    })
                    .finally(() => {
                        fullRefreshTask = undefined;
                        if (fullRefreshRequested && !disposed) {
                            refreshInBackground();
                        }
                    });
                return fullRefreshTask;
            };

            requestEditHistoryCatchUp = () => {
                if (editHistoryUnavailable) {
                    return;
                }

                catchUpRequested = true;
                if (catchUpTask) return;

                const priorRefresh = fullRefreshTask;
                catchUpTask = (async () => {
                    if (priorRefresh) await priorRefresh;
                    while (catchUpRequested && !disposed) {
                        catchUpRequested = false;
                        await catchUpFromEditHistory();
                    }
                })()
                    .catch((error: unknown) => {
                        switchToDirectWebsocketMode(error);
                    })
                    .finally(() => {
                        catchUpTask = undefined;
                        if (catchUpRequested && !disposed) {
                            requestEditHistoryCatchUp?.();
                        }
                    });
            };

            const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
                const objects = await fetchFoundryObjects(
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
                    const receipt = commit(opts.signal);
                    if (receipt !== true) await receipt;
                }
            };

            const loadSubsetDedupe = new DeduplicatedLoadSubset({ loadSubset });
            const unsubscribe = live
                ? getObjectSetWatcherManager(client).subscribe({ type: "base", objectType }, (message) => {
                      switch (message.type) {
                          case "change": {
                              if (fullRefreshTask) {
                                  pendingDirectWatcherUpdates.push(...message.updates);
                              } else if (editHistoryUnavailable) {
                                  void applyDirectWatcherUpdates(message.updates).catch((error: unknown) => {
                                      console.warn(
                                          `Failed to apply direct Foundry updates for ${objectType}.`,
                                          error
                                      );
                                      refreshInBackground();
                                  });
                              } else {
                                  pendingDirectWatcherUpdates.push(...message.updates);
                                  requestEditHistoryCatchUp?.();
                              }
                              break;
                          }
                          case "refresh": {
                              if (editHistoryUnavailable) {
                                  refreshInBackground();
                              } else {
                                  requestEditHistoryCatchUp?.();
                              }
                              break;
                          }
                          case "state": {
                              if (message.status !== "open") break;
                              if (editHistoryUnavailable) {
                                  refreshInBackground();
                              } else {
                                  requestEditHistoryCatchUp?.();
                              }
                              break;
                          }
                      }
                  })
                : () => {};

            // start task here, cleanup can stop it
            // in that task:
            // - spawn object set subscription, which sends messages to catch up
            // - actions sends messages to catch up

            if (initialCommit === true) {
                markReady();
            } else {
                void initialCommit.then(markReady, markError);
            }

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: () => {
                    disposed = true;
                    requestEditHistoryCatchUp = undefined;
                    requestFullRefresh = undefined;
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
    selectedProperties: string[];
    live?: boolean;
    decodeObject?: (object: Record<string, unknown>) => Record<string, unknown>;
    decodeEditObject?: (object: Record<string, unknown>) => Record<string, unknown>;
}

export interface ObjectCollectionConfig<TSchema extends StandardSchema<OntologyObject>>
    extends
        ObjectCollectionOpts,
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
// oxlint-disable-next-line typescript/no-explicit-any
export function objectCollectionOptions(config: any): any {
    const {
        client,
        objectType,
        primaryKeyProperty,
        selectedProperties,
        live,
        decodeObject,
        decodeEditObject,
        schema,
        ...rest
    } = config as ObjectCollectionOpts & { schema?: StandardSchema<OntologyObject> } & Record<
            string,
            unknown
        >;
    const { sync, utils } = createSyncConfig(
        client,
        objectType,
        primaryKeyProperty,
        selectedProperties,
        decodeObject,
        decodeEditObject,
        live
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
