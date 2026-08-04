import { CloudKitError } from "@party-stack/cloudkit-client";
import {
    cloudKitPrimaryKeyFromRecordName,
    cloudKitRecordName,
    cloudKitRecordTypeForObjectType,
    decodeCloudKitObject,
} from "./codec.js";
import type {
    CloudKitClient,
    CloudKitLocation,
} from "@party-stack/cloudkit-client";
import type {
    OntologyCollectionOptions,
    OntologyIR,
    OntologyObject,
} from "@party-stack/ontology";
import {
    parseWhereExpression,
    type FieldPath,
    type LoadSubsetOptions,
    type SyncConfig,
} from "@tanstack/db";

const CURSOR_METADATA_KEY = "cloudkit-zone-cursor";
const RECORD_TAG_METADATA_KEY = "cloudKitRecordChangeTag";

function ontologyObjectsEqual(
    left: OntologyObject,
    right: OntologyObject
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

interface PrimaryKeyFilter {
    supported: boolean;
    keys: Array<string | number>;
}

function primaryKeysFromSubset(
    where: LoadSubsetOptions["where"],
    primaryKey: string
): Array<string | number> | undefined {
    const unsupported = (): PrimaryKeyFilter => ({
        supported: false,
        keys: [],
    });
    const isPrimaryKey = (field: FieldPath) =>
        field.length === 1 && field[0] === primaryKey;
    const parsed = parseWhereExpression<PrimaryKeyFilter>(where, {
        handlers: {
            and: (...filters) => {
                if (
                    filters.length === 0 ||
                    filters.some((filter) => !filter.supported)
                ) {
                    return unsupported();
                }
                const [first, ...rest] = filters;
                return {
                    supported: true,
                    keys: first!.keys.filter(
                        (key: string | number) =>
                        rest.every((filter) =>
                            filter.keys.includes(key)
                        )
                    ),
                };
            },
            or: (...filters) =>
                filters.length > 0 &&
                filters.every((filter) => filter.supported)
                    ? {
                          supported: true,
                          keys: [
                              ...new Set(
                                  filters.flatMap(
                                      (filter) => filter.keys
                                  )
                              ),
                          ],
                      }
                    : unsupported(),
            not: unsupported,
            eq: (field, value) =>
                isPrimaryKey(field) &&
                (typeof value === "string" ||
                    typeof value === "number")
                    ? { supported: true, keys: [value] }
                    : unsupported(),
            in: (field, values) =>
                isPrimaryKey(field) &&
                values.every(
                    (value: unknown) =>
                        typeof value === "string" ||
                        typeof value === "number"
                )
                    ? {
                          supported: true,
                          keys: values as Array<
                              string | number
                          >,
                      }
                    : unsupported(),
            gt: unsupported,
            gte: unsupported,
            lt: unsupported,
            lte: unsupported,
            isNull: unsupported,
            like: unsupported,
            ilike: unsupported,
        },
    });
    return parsed?.supported ? parsed.keys : undefined;
}

export interface CloudKitObjectCollectionUtils {
    catchUp(): Promise<void>;
}

export interface CloudKitObjectCollectionOptions {
    client: CloudKitClient;
    ir: OntologyIR;
    objectType: string;
    location: CloudKitLocation;
    pollIntervalMs?: number;
    recordChangeTags: Map<string, string>;
    registerCatchUp(
        objectType: string,
        catchUp: () => Promise<void>
    ): () => void;
}

export function cloudKitObjectCollectionOptions(
    options: CloudKitObjectCollectionOptions
): OntologyCollectionOptions & {
    utils: CloudKitObjectCollectionUtils;
} {
    const objectType = options.ir.objectTypes.find(
        (candidate) => candidate.name === options.objectType
    );
    if (!objectType) {
        throw new Error(
            `Unknown object type "${options.objectType}".`
        );
    }
    let activeCatchUp: (() => Promise<void>) | undefined;
    const utils: CloudKitObjectCollectionUtils = {
        catchUp: () => activeCatchUp?.() ?? Promise.resolve(),
    };

    const sync: SyncConfig<OntologyObject, string | number> = {
        sync(params) {
            const metadata = params.metadata?.collection;
            for (const [key] of params.collection.entries()) {
                const rowMetadata =
                    params.metadata?.row.get(key);
                if (
                    typeof rowMetadata === "object" &&
                    rowMetadata !== null &&
                    typeof (
                        rowMetadata as Record<string, unknown>
                    )[RECORD_TAG_METADATA_KEY] === "string"
                ) {
                    options.recordChangeTags.set(
                        cloudKitRecordName(
                            options.objectType,
                            key
                        ),
                        (
                            rowMetadata as Record<
                                string,
                                string
                            >
                        )[RECORD_TAG_METADATA_KEY]!
                    );
                }
            }
            const restoredCursor = metadata?.get(
                CURSOR_METADATA_KEY
            );
            let cursor =
                typeof restoredCursor === "string"
                    ? restoredCursor
                    : undefined;
            let disposed = false;
            let requested = false;
            let running: Promise<void> | undefined;

            const performCatchUp = async (
                reset = cursor === undefined
            ): Promise<void> => {
                let nextCursor = reset ? undefined : cursor;
                let firstPage = true;
                do {
                    const page = await options.client.fetchZoneChanges({
                        location: options.location,
                        cursor: nextCursor,
                        recordTypes: [
                            cloudKitRecordTypeForObjectType(
                                options.objectType
                            ),
                        ],
                    });
                    if (disposed) return;

                    params.begin({ immediate: true });
                    if (reset && firstPage) params.truncate();
                    for (const record of page.records) {
                        const object = decodeCloudKitObject({
                            ir: options.ir,
                            objectType: options.objectType,
                            record,
                        });
                        const key = object[
                            objectType.primaryKey
                        ] as string | number;
                        const existing =
                            reset && firstPage
                                ? undefined
                                : params.collection.get(key);
                        if (!existing) {
                            params.write({
                                type: "insert",
                                value: object,
                            });
                        } else if (
                            !ontologyObjectsEqual(existing, object)
                        ) {
                            params.write({
                                type: "update",
                                value: object,
                            });
                        }
                        if (record.recordChangeTag) {
                            options.recordChangeTags.set(
                                record.recordName,
                                record.recordChangeTag
                            );
                            const current =
                                params.metadata?.row.get(key);
                            params.metadata?.row.set(key, {
                                ...(typeof current === "object" &&
                                current !== null
                                    ? current
                                    : {}),
                                [RECORD_TAG_METADATA_KEY]:
                                    record.recordChangeTag,
                            });
                        }
                    }
                    for (const deletion of page.deleted) {
                        const key =
                            cloudKitPrimaryKeyFromRecordName(
                                options.objectType,
                                deletion.recordName
                            );
                        if (key === undefined) continue;
                        if (params.collection.has(key)) {
                            params.write({ type: "delete", key });
                        }
                        options.recordChangeTags.delete(
                            deletion.recordName
                        );
                        params.metadata?.row.delete(key);
                    }
                    nextCursor = page.cursor;
                    metadata?.set(
                        CURSOR_METADATA_KEY,
                        nextCursor
                    );
                    params.commit();
                    firstPage = false;
                    if (!page.moreComing) break;
                } while (!disposed);
                cursor = nextCursor;
            };

            const requestCatchUp = (): Promise<void> => {
                requested = true;
                if (!running) {
                    running = (async () => {
                        while (requested && !disposed) {
                            requested = false;
                            try {
                                await performCatchUp();
                            } catch (error) {
                                if (
                                    error instanceof CloudKitError &&
                                    error.code === "cursorExpired"
                                ) {
                                    cursor = undefined;
                                    await performCatchUp(true);
                                    continue;
                                }
                                throw error;
                            }
                        }
                    })().finally(() => {
                        running = undefined;
                    });
                }
                const current = running;
                return current.then(() => {
                    if (requested && !disposed) {
                        return requestCatchUp();
                    }
                });
            };
            activeCatchUp = requestCatchUp;
            const unregister = options.registerCatchUp(
                options.objectType,
                requestCatchUp
            );
            const unsubscribe =
                options.client.subscribeToChanges?.(() => {
                    void requestCatchUp().catch((error: unknown) => {
                        console.warn(
                            `CloudKit catch-up failed for ${options.objectType}.`,
                            error
                        );
                    });
                });
            const poll =
                options.pollIntervalMs &&
                options.pollIntervalMs > 0
                    ? setInterval(() => {
                          void requestCatchUp().catch(
                              (error: unknown) => {
                                  console.warn(
                                      `CloudKit polling failed for ${options.objectType}.`,
                                      error
                                  );
                              }
                          );
                      }, options.pollIntervalMs)
                    : undefined;

            const zoneReady = options.client.ensureZone(
                options.location
            );
            void zoneReady
                .catch((error: unknown) => {
                    console.warn(
                        `CloudKit zone setup failed for ${options.objectType}.`,
                        error
                    );
                })
                .finally(params.markReady);

            return {
                loadSubset: async (subset) => {
                    await zoneReady;
                    const primaryKeys = primaryKeysFromSubset(
                        subset.where,
                        objectType.primaryKey
                    );
                    if (primaryKeys === undefined) {
                        await requestCatchUp();
                        return;
                    }
                    const records =
                        await options.client.fetchRecords({
                            location: options.location,
                            recordNames: primaryKeys.map((key) =>
                                cloudKitRecordName(
                                    options.objectType,
                                    key
                                )
                            ),
                        });
                    const returnedKeys = new Set<
                        string | number
                    >();
                    params.begin({ immediate: true });
                    for (const record of records) {
                        const object = decodeCloudKitObject({
                            ir: options.ir,
                            objectType: options.objectType,
                            record,
                        });
                        const key = object[
                            objectType.primaryKey
                        ] as string | number;
                        returnedKeys.add(key);
                        const existing =
                            params.collection.get(key);
                        if (!existing) {
                            params.write({
                                type: "insert",
                                value: object,
                            });
                        } else if (
                            !ontologyObjectsEqual(existing, object)
                        ) {
                            params.write({
                                type: "update",
                                value: object,
                            });
                        }
                        if (record.recordChangeTag) {
                            options.recordChangeTags.set(
                                record.recordName,
                                record.recordChangeTag
                            );
                            const current =
                                params.metadata?.row.get(key);
                            params.metadata?.row.set(key, {
                                ...(typeof current === "object" &&
                                current !== null
                                    ? current
                                    : {}),
                                [RECORD_TAG_METADATA_KEY]:
                                    record.recordChangeTag,
                            });
                        }
                    }
                    for (const key of primaryKeys) {
                        if (
                            !returnedKeys.has(key) &&
                            params.collection.has(key)
                        ) {
                            params.write({ type: "delete", key });
                            params.metadata?.row.delete(key);
                            options.recordChangeTags.delete(
                                cloudKitRecordName(
                                    options.objectType,
                                    key
                                )
                            );
                        }
                    }
                    params.commit();
                },
                cleanup: () => {
                    disposed = true;
                    activeCatchUp = undefined;
                    unregister();
                    unsubscribe?.();
                    if (poll) clearInterval(poll);
                },
            };
        },
    };

    return {
        syncMode: "on-demand",
        startSync: true,
        sync,
        utils,
    };
}
