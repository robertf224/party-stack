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

type BufferedObjectUpdate = {
    state: "ADDED_OR_UPDATED" | "REMOVED";
    object: FoundryObject;
};

type CollectionSyncState = {
    pendingKeyCounts: Map<string | number, number>;
    bufferedObjectUpdates: Map<string | number, BufferedObjectUpdate>;
    needsRefresh: boolean;
    resetLoadSubsetDedupe?: () => void;
};

const collectionSyncStates = new WeakMap<Collection, CollectionSyncState>();

function createCollectionSyncState(): CollectionSyncState {
    return {
        pendingKeyCounts: new Map(),
        bufferedObjectUpdates: new Map(),
        needsRefresh: false,
    };
}

function getCollectionSyncState(collection: Collection): CollectionSyncState {
    let state = collectionSyncStates.get(collection);
    if (!state) {
        state = createCollectionSyncState();
        collectionSyncStates.set(collection, state);
    }
    return state;
}

function markPendingKeys(
    state: CollectionSyncState,
    keys: Iterable<string | number>
): void {
    for (const key of keys) {
        state.pendingKeyCounts.set(key, (state.pendingKeyCounts.get(key) ?? 0) + 1);
    }
}

function releasePendingKeys(
    state: CollectionSyncState,
    keys: Iterable<string | number>
): void {
    for (const key of keys) {
        const nextCount = (state.pendingKeyCounts.get(key) ?? 0) - 1;
        if (nextCount > 0) {
            state.pendingKeyCounts.set(key, nextCount);
        } else {
            state.pendingKeyCounts.delete(key);
        }
    }
}

function isPendingKey(state: CollectionSyncState, key: string | number): boolean {
    return (state.pendingKeyCounts.get(key) ?? 0) > 0;
}

function applyBufferedObjectUpdates(opts: {
    collection: Collection<Record<string, unknown>>;
    controller: ManualSyncController;
    state: CollectionSyncState;
}): void {
    const readyUpdates = Array.from(opts.state.bufferedObjectUpdates.entries()).filter(
        ([key]) => !isPendingKey(opts.state, key)
    );
    if (readyUpdates.length === 0 && !opts.state.needsRefresh) {
        return;
    }

    if (readyUpdates.length > 0) {
        opts.controller.begin({ immediate: true });
        for (const [key, update] of readyUpdates) {
            opts.state.bufferedObjectUpdates.delete(key);
            const previousValue = opts.collection.get(key);
            if (update.state === "REMOVED") {
                if (previousValue) {
                    opts.controller.write({ type: "delete", key, previousValue });
                }
                continue;
            }
            opts.controller.write({
                type: previousValue ? "update" : "insert",
                value: update.object,
                previousValue,
            });
        }
        opts.controller.commit();
    }

    if (opts.state.needsRefresh) {
        opts.state.resetLoadSubsetDedupe?.();
        opts.state.needsRefresh = false;
    }
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

async function fetchFoundryObjectsByPrimaryKeys(
    client: OntologyClient,
    objectType: string,
    primaryKey: string,
    keys: Array<string | number>,
    decodeObject: (object: FoundryObject) => FoundryObject = (object) => object
): Promise<FoundryObject[]> {
    return fetchFoundryObjects(
        client,
        objectType,
        {
            where: {
                type: "in",
                left: {
                    type: "ref",
                    path: [primaryKey],
                },
                value: keys,
            } as unknown as LoadSubsetOptions["where"],
            limit: keys.length,
        },
        decodeObject
    );
}

async function syncActionEditsIntoCollections(opts: {
    client: OntologyClient;
    ir: OntologyIR;
    decodeObject: (objectType: string, object: FoundryObject) => FoundryObject;
    edits: Exclude<Awaited<ReturnType<typeof Actions.applyWithOverrides>>["edits"], undefined>;
    objectCollections: Record<string, Collection<Record<string, unknown>>>;
}) {
    if (opts.edits.type !== "edits") {
        return;
    }

    const objectTypes = new Map(opts.ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    const keysByObjectType = new Map<
        string,
        {
            upserts: Set<string | number>;
            deletes: Set<string | number>;
        }
    >();

    for (const edit of opts.edits.edits) {
        if (edit.type !== "addObject" && edit.type !== "modifyObject" && edit.type !== "deleteObject") {
            continue;
        }
        const entry = keysByObjectType.get(edit.objectType) ?? {
            upserts: new Set<string | number>(),
            deletes: new Set<string | number>(),
        };
        if (edit.type === "deleteObject") {
            entry.deletes.add(edit.primaryKey as string | number);
            entry.upserts.delete(edit.primaryKey as string | number);
        } else {
            entry.upserts.add(edit.primaryKey as string | number);
        }
        keysByObjectType.set(edit.objectType, entry);
    }

    for (const [objectTypeName, keys] of keysByObjectType) {
        const collection = opts.objectCollections[objectTypeName];
        const controller = collection ? manualSyncControllers.get(collection) : undefined;
        const syncState = collection ? collectionSyncStates.get(collection) : undefined;
        const objectType = objectTypes.get(objectTypeName);
        if (!collection || !controller || !syncState || !objectType) {
            continue;
        }

        const affectedKeys = [...keys.upserts, ...keys.deletes];
        markPendingKeys(syncState, affectedKeys);

        try {
            const upsertedObjects = await fetchFoundryObjectsByPrimaryKeys(
                opts.client,
                objectTypeName,
                objectType.primaryKey,
                Array.from(keys.upserts),
                (object) => opts.decodeObject(objectTypeName, object)
            );

            controller.begin({ immediate: true });
            for (const key of keys.deletes) {
                const previousValue = collection.get(key);
                controller.write({ type: "delete", key, previousValue });
            }
            for (const object of upsertedObjects) {
                const previousValue = collection.get(object.__primaryKey);
                controller.write({
                    type: previousValue ? "update" : "insert",
                    value: object,
                    previousValue,
                });
            }
            controller.commit();
        } finally {
            releasePendingKeys(syncState, affectedKeys);
            applyBufferedObjectUpdates({
                collection,
                controller,
                state: syncState,
            });
        }
    }
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
            const syncState = getCollectionSyncState(collection as Collection);

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
                }
            };
            const loadSubsetDedupe = new DeduplicatedLoadSubset({ loadSubset });
            syncState.resetLoadSubsetDedupe = () => {
                loadSubsetDedupe.reset();
            };
            const objectSetWatcherManager = getObjectSetWatcherManager(client);
            const unsubscribe = objectSetWatcherManager.subscribe({ type: "base", objectType }, (message) => {
                switch (message.type) {
                    case "change": {
                        let hasImmediateWrites = false;
                        for (const update of message.updates) {
                            if (update.type === "object") {
                                const object = decodeObject(update.object as FoundryObject);
                                if (isPendingKey(syncState, object.__primaryKey)) {
                                    syncState.bufferedObjectUpdates.set(object.__primaryKey, {
                                        state: update.state,
                                        object,
                                    });
                                    continue;
                                }
                                if (!hasImmediateWrites) {
                                    begin();
                                    hasImmediateWrites = true;
                                }
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
                        if (hasImmediateWrites) {
                            commit();
                        }
                        break;
                    }
                    case "refresh": {
                        if (syncState.pendingKeyCounts.size > 0) {
                            syncState.needsRefresh = true;
                        } else {
                            loadSubsetDedupe.reset();
                        }
                        break;
                    }
                }
            });

            markReady();

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: () => {
                    manualSyncControllers.delete(collection as Collection);
                    collectionSyncStates.delete(collection as Collection);
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
                await syncActionEditsIntoCollections({
                    client: opts.client,
                    ir: opts.ir,
                    decodeObject: (objectType, object) =>
                        decoder.decodeObject(objectType, object) as FoundryObject,
                    edits: result.edits,
                    objectCollections: context.objects,
                });
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
