import { Actions, OntologyObjectsV2, OntologyObjectV2 } from "@osdk/foundry.ontologies";
import {
    Collection,
    CollectionConfig,
    createCollection,
    DeduplicatedLoadSubset,
    InferSchemaOutput,
    LoadSubsetOptions,
    NonRetriableError,
    StandardSchema,
    SyncConfig,
    UtilsRecord,
} from "@tanstack/db";
import type { OntologyAdapter, OntologyIR } from "@party-stack/ontology";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
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

type ManualSyncController = {
    begin: (options?: { immediate?: boolean }) => void;
    write: (
        message:
            | {
                  type: "insert" | "update";
                  value: Record<string, unknown>;
                  previousValue?: Record<string, unknown>;
              }
            | {
                  type: "delete";
                  key: string | number;
                  previousValue?: Record<string, unknown>;
              }
    ) => void;
    commit: () => void;
};

const manualSyncControllers = new WeakMap<Collection, ManualSyncController>();
const COLLECTION_SYNC_TIMEOUT_MS = 5_000;

type CollectionSyncEvent = "upsert" | "delete";

type CollectionSyncWaiter = {
    afterVersion: number;
    event: CollectionSyncEvent;
    resolve: () => void;
    timeoutId: ReturnType<typeof setTimeout>;
};

type CollectionSyncTracker = {
    versions: Map<string | number, number>;
    lastEvents: Map<string | number, CollectionSyncEvent>;
    waiters: Map<string | number, Set<CollectionSyncWaiter>>;
};

const collectionSyncTrackers = new WeakMap<Collection, CollectionSyncTracker>();

function getCollectionSyncTracker(collection: Collection): CollectionSyncTracker {
    let tracker = collectionSyncTrackers.get(collection);
    if (!tracker) {
        tracker = {
            versions: new Map(),
            lastEvents: new Map(),
            waiters: new Map(),
        };
        collectionSyncTrackers.set(collection, tracker);
    }
    return tracker;
}

function getCollectionSyncVersion(collection: Collection, key: string | number): number {
    return getCollectionSyncTracker(collection).versions.get(key) ?? 0;
}

function recordCollectionSyncEvent(
    collection: Collection,
    key: string | number,
    event: CollectionSyncEvent
): void {
    const tracker = getCollectionSyncTracker(collection);
    const version = (tracker.versions.get(key) ?? 0) + 1;
    tracker.versions.set(key, version);
    tracker.lastEvents.set(key, event);

    const waiters = tracker.waiters.get(key);
    if (!waiters) {
        return;
    }

    for (const waiter of Array.from(waiters)) {
        if (version > waiter.afterVersion && waiter.event === event) {
            clearTimeout(waiter.timeoutId);
            waiters.delete(waiter);
            waiter.resolve();
        }
    }

    if (waiters.size === 0) {
        tracker.waiters.delete(key);
    }
}

function waitForCollectionSyncEvent(opts: {
    collection: Collection;
    key: string | number;
    event: CollectionSyncEvent;
    afterVersion: number;
}): Promise<void> {
    const tracker = getCollectionSyncTracker(opts.collection);
    const currentVersion = tracker.versions.get(opts.key) ?? 0;
    const currentEvent = tracker.lastEvents.get(opts.key);
    if (currentVersion > opts.afterVersion && currentEvent === opts.event) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const waiters = tracker.waiters.get(opts.key) ?? new Set<CollectionSyncWaiter>();
        const waiter: CollectionSyncWaiter = {
            afterVersion: opts.afterVersion,
            event: opts.event,
            resolve: () => {
                waiters.delete(waiter);
                if (waiters.size === 0) {
                    tracker.waiters.delete(opts.key);
                }
                resolve();
            },
            timeoutId: setTimeout(() => {
                waiters.delete(waiter);
                if (waiters.size === 0) {
                    tracker.waiters.delete(opts.key);
                }
                resolve();
            }, COLLECTION_SYNC_TIMEOUT_MS),
        };
        waiters.add(waiter);
        tracker.waiters.set(opts.key, waiters);
    });
}

function getActionSyncTargets(opts: {
    edits: Exclude<Awaited<ReturnType<typeof Actions.applyWithOverrides>>["edits"], undefined>;
    objectCollections: Record<string, Collection<Record<string, unknown>>>;
}): Array<{
    collection: Collection<Record<string, unknown>>;
    key: string | number;
    event: CollectionSyncEvent;
    afterVersion: number;
}> {
    if (opts.edits.type !== "edits") {
        return [];
    }

    const finalEventsByObjectType = new Map<string, Map<string | number, CollectionSyncEvent>>();
    for (const edit of opts.edits.edits) {
        if (edit.type !== "addObject" && edit.type !== "modifyObject" && edit.type !== "deleteObject") {
            continue;
        }

        const event: CollectionSyncEvent = edit.type === "deleteObject" ? "delete" : "upsert";
        const entries =
            finalEventsByObjectType.get(edit.objectType) ?? new Map<string | number, CollectionSyncEvent>();
        entries.set(edit.primaryKey as string | number, event);
        finalEventsByObjectType.set(edit.objectType, entries);
    }

    return Array.from(finalEventsByObjectType.entries()).flatMap(([objectType, entries]) => {
        const collection = opts.objectCollections[objectType];
        if (!collection) {
            return [];
        }

        return Array.from(entries.entries()).map(([key, event]) => ({
            collection,
            key,
            event,
            afterVersion: getCollectionSyncVersion(collection, key),
        }));
    });
}

function serializeOverrideValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return JSON.stringify(value) ?? "";
}

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

export function createFoundryObjectSyncConfig(
    client: OntologyClient,
    objectType: string,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): SyncConfig<Record<string, unknown>, string | number> {
    return {
        sync: (params) => {
            const { begin, write, commit, markReady, collection } = params;
            manualSyncControllers.set(collection as Collection, { begin, write, commit });
            getCollectionSyncTracker(collection as Collection);

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

            const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
                const objects = await fetchFoundryObjects(client, objectType, opts, decodeObject);
                if (objects.length > 0) {
                    begin();
                    for (const object of objects) {
                        upsertObject(object);
                    }
                    commit();
                    for (const object of objects) {
                        recordCollectionSyncEvent(collection as Collection, object.__primaryKey, "upsert");
                    }
                }
            };
            const loadSubsetDedupe = new DeduplicatedLoadSubset({ loadSubset });
            const objectSetWatcherManager = getObjectSetWatcherManager(client);
            const unsubscribe = objectSetWatcherManager.subscribe({ type: "base", objectType }, (message) => {
                switch (message.type) {
                    case "change": {
                        const syncEvents: Array<{ key: string | number; event: CollectionSyncEvent }> = [];
                        begin();
                        for (const update of message.updates) {
                            if (update.type === "object") {
                                const object = decodeObject(update.object as FoundryObject);
                                switch (update.state) {
                                    case "ADDED_OR_UPDATED": {
                                        upsertObject(object);
                                        syncEvents.push({ key: object.__primaryKey, event: "upsert" });
                                        break;
                                    }
                                    case "REMOVED": {
                                        deleteObject(object);
                                        syncEvents.push({ key: object.__primaryKey, event: "delete" });
                                        break;
                                    }
                                }
                            }
                        }
                        commit();
                        for (const syncEvent of syncEvents) {
                            recordCollectionSyncEvent(
                                collection as Collection,
                                syncEvent.key,
                                syncEvent.event
                            );
                        }
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
                cleanup: () => {
                    manualSyncControllers.delete(collection as Collection);
                    collectionSyncTrackers.delete(collection as Collection);
                    unsubscribe();
                },
            };
        },
    };
}

export function createFoundryOntologyAdapter(opts: {
    client: OntologyClient;
    ir: OntologyIR;
}): OntologyAdapter {
    const decoder = createFoundryObjectDecoder(opts.ir);

    return {
        name: "foundry",
        getCollectionOptions: (objectType: string) => ({
            syncMode: "on-demand",
            sync: createFoundryObjectSyncConfig(
                opts.client,
                objectType,
                (object) => decoder.decodeObject(objectType, object) as FoundryObject
            ),
        }),
        applyAction: async (name, parameters, context) => {
            const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === name)!;
            const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
            const requestParameters: Record<string, unknown> = {};
            const uniqueIdentifierLinkIdValues: Record<string, string> = {};
            let actionExecutionTime: string | undefined;

            for (const [parameterName, value] of Object.entries(parameters)) {
                if (overrideMapping.uuidByParameterName.has(parameterName)) {
                    if (value !== undefined) {
                        uniqueIdentifierLinkIdValues[
                            overrideMapping.uuidByParameterName.get(parameterName)!
                        ] = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (overrideMapping.nowParameterName === parameterName) {
                    if (value !== undefined) {
                        actionExecutionTime = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (value !== undefined) {
                    requestParameters[parameterName] = value;
                }
            }

            const result = await Actions.applyWithOverrides(
                opts.client,
                opts.client.ontologyRid,
                toFoundryActionTypeName(name),
                {
                    request: {
                        options: {
                            mode: "VALIDATE_AND_EXECUTE",
                            returnEdits: "ALL_V2_WITH_DELETIONS",
                        },
                        parameters: requestParameters,
                    },
                    overrides: {
                        uniqueIdentifierLinkIdValues,
                        actionExecutionTime,
                    },
                },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                {
                    preview: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any
            );
            if (result.validation?.result === "INVALID") {
                throw new NonRetriableError("Invalid Action arguments.");
            }
            if (context && result.edits) {
                const syncTargets = getActionSyncTargets({
                    edits: result.edits,
                    objectCollections: context.objects,
                });
                await Promise.all(syncTargets.map((target) => waitForCollectionSyncEvent(target)));
            }
        },
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
