import { createLiveQueryCollection, prepareLiveQueryValue } from "@tanstack/db";
import { initialListQuery, pageSize, setPreparedListPageSize } from "./runtime.js";
import type {
    Collection,
    BaseQueryBuilder,
    Context,
    DbClient,
    GetResult,
    LiveQueryCollectionConfig,
    LiveQueryCollectionUtils,
    NonSingleResult,
    SingleResult,
} from "@tanstack/db";

export type PrepareQueryOptions = { readonly gcTime?: number };

/** The exact native graph retained during preparation, not a snapshot of its rows. */
export type PreparedQuery<Result extends Context> = {
    readonly collection: Collection<
        GetResult<Result> extends object ? GetResult<Result> : never,
        string | number,
        LiveQueryCollectionUtils
    > &
        (Result extends SingleResult ? SingleResult : NonSingleResult);
    readonly ready: Promise<void>;
    /** Release only the temporary preparation subscription after the reader commits. */
    readonly release: () => void;
    /** Close an abandoned graph, or close it when its external owner is disposed. */
    readonly cleanup: () => Promise<void>;
};

type QueryInput<Result extends Context> = LiveQueryCollectionConfig<Result>["query"];

/** Start one query before render and hand its Collection directly to the reader.
 * Descriptor binding uses the pinned DB RC's exported, unstable adapter boundary.
 */
export function prepareQuery<Result extends Context>(
    client: DbClient,
    query: QueryInput<Result>,
    options?: PrepareQueryOptions
): PreparedQuery<Result> {
    // The native resolver binds descriptors inside fragment includes as well as
    // root sources. It does not register a DbClient preloaded row snapshot.
    const bound = prepareLiveQueryValue(query, client) as QueryInput<Result>;
    return retain(bound, options);
}

/** Prepare a root list with one sentinel row while preserving its original page size. */
export function prepareListQuery<Result extends Context & NonSingleResult>(
    client: DbClient,
    query: QueryInput<Result>,
    options?: PrepareQueryOptions
): PreparedQuery<Result> {
    const bound = prepareLiveQueryValue(query, client) as BaseQueryBuilder<Result>;
    const size = pageSize(bound._getQuery());
    const prepared = retain(initialListQuery(bound), options);
    setPreparedListPageSize(prepared.collection, size);
    return prepared;
}

function retain<Result extends Context>(
    query: QueryInput<Result>,
    options: PrepareQueryOptions | undefined
): PreparedQuery<Result> {
    const collection = createLiveQueryCollection({ query, gcTime: options?.gcTime ?? 1 });
    let subscription: ReturnType<typeof collection.subscribeChanges> | undefined;
    let closing: Promise<void> | undefined;
    const release = () => {
        subscription?.unsubscribe();
        subscription = undefined;
    };
    const cleanup = () => {
        release();
        return (closing ??= collection.cleanup({ dependents: true }));
    };
    try {
        subscription = collection.subscribeChanges(() => {});
    } catch (error) {
        void cleanup().catch(() => {});
        throw error;
    }
    const ready = collection.preload().catch(async (error: unknown) => {
        // A cleanup failure must not replace the original acquisition failure.
        await cleanup().catch(() => {});
        throw error;
    });
    // The owner may abandon preparation without consuming ready. Keep the same
    // rejecting Promise available to readers without an unhandled rejection.
    void ready.catch(() => {});
    return { collection, ready, release, cleanup } as PreparedQuery<Result>;
}
