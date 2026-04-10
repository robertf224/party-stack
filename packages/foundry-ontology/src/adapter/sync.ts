import {
    ObjectTypesV2,
    type ObjectEditHistoryEntry,
    type ObjectPrimaryKeyV2,
} from "@osdk/foundry.ontologies";
import { useObjectSetWatcherSubscription } from "@party-stack/foundry-object-set-watcher/effection";
import { call, createSignal, run, spawn, suspend } from "effection";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { SyncConfig } from "@tanstack/db";
import type { Channel } from "effection";

type FoundryObject = Record<string, unknown>;

const EDIT_HISTORY_PAGE_SIZE = 1_000;

interface CreateSyncConfigOpts {
    client: OntologyClient;
    objectType: string;
    operationIds: Channel<string, void>;
    primaryKeyProperty: string;
    decodeObject?: (object: FoundryObject) => FoundryObject;
}

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

function normalizeEditPropertyValue(value: unknown): unknown {
    if (isNullPropertyValue(value)) return undefined;
    const geoPoint = parseGeoPointPropertyValue(value);
    if (geoPoint) return geoPoint;
    if (isWrappedPrimitivePropertyValue(value)) return value.value;
    if (Array.isArray(value)) return value.map(normalizeEditPropertyValue);
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [
                key,
                normalizeEditPropertyValue(nestedValue),
            ])
        );
    }
    return value;
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

export function createSyncConfig(
    opts: CreateSyncConfigOpts
): SyncConfig<Record<string, unknown>, string | number> {
    const { client, objectType, operationIds, primaryKeyProperty, decodeObject = (object) => object } =
        opts;

    return {
        sync: (params) => {
            const { begin, write, commit, markReady } = params;
            const syncedKeys = new Set<string | number>(params.collection.keys());
            const editHistoryCursor = createEditHistoryCursor();
            const invalidations = createSignal<void, void>();

            const fetchEditHistoryPage = (
                body: Parameters<typeof ObjectTypesV2.getEditsHistory>[3],
            ) =>
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
                });

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

            const catchUpFromEditHistory = function* () {
                const pendingMutations = new Map<
                    string | number,
                    { type: "upsert"; object: FoundryObject } | { type: "delete" }
                >();
                const newOperationIds = new Set<string>();
                let pageToken: string | undefined;

                while (true) {
                    const page = yield* call(() =>
                        fetchEditHistoryPage({
                            filters: {
                                type: "timestampFilter",
                                startTime: editHistoryCursor.timestamp,
                            },
                            includeAllPreviousProperties: true,
                            pageSize: EDIT_HISTORY_PAGE_SIZE,
                            pageToken,
                            sortOrder: "oldest_first",
                        })
                    );

                    for (const entry of page.data) {
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

                    if (page.nextPageToken === undefined) {
                        break;
                    }

                    pageToken = page.nextPageToken;
                }

                let transactionStarted = false;
                for (const [primaryKey, mutation] of pendingMutations) {
                    if (mutation.type === "delete" && !syncedKeys.has(primaryKey)) {
                        continue;
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

                for (const operationId of newOperationIds) {
                    yield* operationIds.send(operationId);
                }
            };

            const task = run(function* () {
                void (yield* spawn(function* () {
                    const messages = yield* useObjectSetWatcherSubscription({
                        type: "base",
                        objectType,
                    });

                    while (true) {
                        const nextMessage = yield* messages.next();
                        if (nextMessage.done) {
                            break;
                        }

                        const message = nextMessage.value;
                        switch (message.type) {
                            case "change":
                            case "refresh":
                                invalidations.send();
                                break;
                            case "state":
                                if (message.status === "open") {
                                    invalidations.send();
                                }
                                break;
                        }
                    }
                }));

                void (yield* spawn(function* () {
                    const requests = yield* invalidations;

                    while (true) {
                        const nextRequest = yield* requests.next();
                        if (nextRequest.done) {
                            break;
                        }

                        try {
                            yield* catchUpFromEditHistory();
                        } catch (error) {
                            console.error("Error during edit history catch-up", error);
                        }
                    }
                }));

                markReady();
                yield* suspend();
            });

            return {
                cleanup: () => {
                    void task.halt();
                },
            };
        },
    };
}
