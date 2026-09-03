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
import type { SalesforceClient } from "@party-stack/salesforce-client";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import {
    buildSoqlQuery,
    convertLoadSubsetFilter,
    convertLoadSubsetOrderBy,
    isAlwaysFalseFilter,
} from "./convertLoadSubsetOptions.js";

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

type SalesforceObject = Record<string, unknown>;

export interface ObjectCollectionUtils extends UtilsRecord {
    /**
     * Reset load-subset deduplication so subsequent reads refetch after writes.
     */
    invalidate: () => void;
    /** Apply a confirmed backend deletion to the local collection. */
    deleteByKey: (
        key: string | number
    ) => Promise<void>;
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
    selectedProperties: string[],
    decodeObject: (object: SalesforceObject) => SalesforceObject = (object) => object
): { sync: SyncConfig<Record<string, unknown>, string | number>; utils: ObjectCollectionUtils } {
    let loadSubsetDedupe: DeduplicatedLoadSubset | undefined;
    let deleteByKey:
        | ((
              key: string | number
          ) => Promise<void>)
        | undefined;

    const utils: ObjectCollectionUtils = {
        invalidate: () => {
            loadSubsetDedupe?.reset();
        },
        deleteByKey: (key) => {
            if (!deleteByKey) {
                throw new Error(
                    `Salesforce ${objectType} collection is not ready.`
                );
            }
            return deleteByKey(key);
        },
    };

    const sync: SyncConfig<Record<string, unknown>, string | number> = {
        sync: (params) => {
            const { begin, write, commit, markReady } = params;

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

            const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
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
                    await commit();
                }
            };

            loadSubsetDedupe = new DeduplicatedLoadSubset({ loadSubset });
            deleteByKey = async (key) => {
                begin();
                write({
                    type: "delete",
                    key,
                });
                await commit();
                loadSubsetDedupe?.reset();
            };
            markReady();

            return {
                loadSubset: loadSubsetDedupe.loadSubset,
                cleanup: () => {
                    loadSubsetDedupe?.reset();
                    loadSubsetDedupe = undefined;
                    deleteByKey = undefined;
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
    decodeObject?: (object: Record<string, unknown>) => Record<string, unknown>;
}

export interface ObjectCollectionConfig<TSchema extends StandardSchema<SalesforceObject>>
    extends ObjectCollectionOpts,
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function objectCollectionOptions(config: any): any {
    const { client, objectType, primaryKeyProperty, selectedProperties, decodeObject, schema, ...rest } =
        config as ObjectCollectionOpts & { schema?: StandardSchema<SalesforceObject> } & Record<
            string,
            unknown
        >;
    const { sync, utils } = createSyncConfig(client, objectType, selectedProperties, decodeObject);

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
