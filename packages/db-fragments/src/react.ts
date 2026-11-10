"use client";
import { BaseQueryBuilder } from "@tanstack/db";
import { useLiveInfiniteQuery, useLiveSuspenseQuery } from "@tanstack/react-db";
import {
    hasInstalledWindow,
    initialListQuery,
    listRecipe,
    pageSize,
    preparedListPageSize,
} from "./runtime.js";
import type { Collection, Context, GetResult, HealthNode, NonSingleResult, QueryBuilder } from "@tanstack/db";
import type { UseLiveInfiniteQueryReturnWithCollection } from "@tanstack/react-db";

/** Read a singular fragment through the enclosing query. Native includes currently lose their
 * single-result marker, so check cardinality here without another query or cache.
 * Plural includes use the native collection query hooks.
 */
export function useFragment<Row extends object>(fragment: Collection<Row>): { data: Row | undefined } {
    const result = useLiveSuspenseQuery(fragment as Collection<Row> & NonSingleResult);
    if (Reflect.get(fragment.config, "singleResult") === true)
        return { data: result.data as unknown as Row | undefined };
    if (result.data.length > 1)
        throw new Error(
            "useFragment expects at most one matching row. Read plural collections with a list query hook."
        );
    return { data: result.data[0] };
}

type ListResult<Row extends object> = UseLiveInfiniteQueryReturnWithCollection<Row, string | number, {}> & {
    health: HealthNode | undefined;
};
// Collection utilities are invariant through mutation callbacks. Infer each
// concrete native input before distributing a root/child/query union's row type.
type ListInput = Collection<any, any, any, any, any> | QueryBuilder<any>;
type ListInputRow<Input extends ListInput> =
    Input extends Collection<any, any, any, any, any>
        ? Input["toArray"][number]
        : Input extends QueryBuilder<infer Result>
          ? GetResult<Result>
          : never;
export function useListFragment<Input extends ListInput>(fragment: Input): ListResult<ListInputRow<Input>>;
export function useListFragment(fragment: unknown) {
    const query = fragment instanceof BaseQueryBuilder ? (fragment as QueryBuilder<Context>) : undefined;
    const input = query ? () => initialListQuery(query) : fragment;
    const result = useLiveSuspenseQuery(input as Collection<object> & NonSingleResult);
    if (!Array.isArray(result.data))
        throw new Error("useListFragment requires a plural query. Use useFragment for a single object.");
    const recipe = listRecipe(result.collection);
    const window = Reflect.get(result.collection.utils, "getWindow")?.() as { limit?: number } | undefined;
    if (!recipe && !window)
        throw new Error(
            "This child collection has no list recipe. Compose it with defineListFragment.include."
        );
    const size =
        recipe?.pageSize ??
        preparedListPageSize(result.collection) ??
        (query
            ? pageSize((query as BaseQueryBuilder)._getQuery())
            : Number.isSafeInteger(window?.limit) && window!.limit! > 0
              ? window!.limit!
              : 50);
    // A child is re-rooted over its original sources and concrete parent bindings,
    // never over the limited child Collection. Root inputs reuse their existing
    // query collection. Both paths use DB's native page/window controller.
    const next = recipe ? () => initialListQuery(recipe.query) : result.collection;
    const infinite = useLiveInfiniteQuery(next as Collection<object> & NonSingleResult, { pageSize: size });
    const installed = hasInstalledWindow(infinite.collection, infinite.isReady);
    const health = Reflect.get(infinite, "health") as HealthNode | undefined;
    if (!recipe || installed) return { ...infinite, health };
    // The included page is already live and complete. Keep reading it while the
    // independently owned root acquires its initial window; don't manufacture a
    // row cache or expose a second empty/loading view during this handoff.
    return {
        ...infinite,
        data: result.data.slice(0, size),
        state: result.state,
        pages: [result.data.slice(0, size)],
        hasNextPage: result.data.length >= size,
        isFetchingNextPage: infinite.isFetchingNextPage || infinite.isLoading,
        health: health ?? result.health,
    };
}
