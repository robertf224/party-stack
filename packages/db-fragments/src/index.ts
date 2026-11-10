import { eq, include, Query } from "@tanstack/db";
import { fragmentInclude } from "./runtime.js";
import type {
    Collection,
    Context,
    ContextFromSource,
    GetResult,
    RefsForContext,
    ResultTypeFromSelect,
    SelectObject,
    Source,
    QueryBuilder,
    WithResult,
} from "@tanstack/db";

type RowRef<S extends Source[string]> =
    RefsForContext<ContextFromSource<{ row: S }>> extends { row: infer R } ? R : never;
type Selected<S extends SelectObject> = WithResult<Context, ResultTypeFromSelect<S>>;
type FragmentInclude<S extends SelectObject> = ReturnType<typeof include<Selected<S>>>;
type NoArguments = Record<never, never>;

type ArgumentInput<Args extends object> = keyof Args extends never ? Record<string, never> : Args;
type FragmentCall<Args extends object> =
    // Only fragments whose arguments are all optional can omit them.
    NoArguments extends Args ? [args?: ArgumentInput<Args>] : [args: ArgumentInput<Args>];

type FragmentOptions<S extends Source[string]> = {
    readonly key?: (row: RowRef<S>) => unknown;
};
/** A parent-bound native query. Extend it directly so include sees its correlation. */
export type FragmentQuery<S extends Source[string]> = QueryBuilder<ContextFromSource<{ row: S }>>;

type Fragment<S extends Source[string], Selection extends SelectObject, Args extends object> = {
    readonly source: S;
    readonly include: (
        row: RowRef<S> | FragmentQuery<S>,
        ...args: FragmentCall<Args>
    ) => FragmentInclude<Selection>;
};
type FragmentFromArguments<
    S extends Source[string],
    Selection extends SelectObject,
    Args extends unknown[],
> = Args extends [] | [args?: object]
    ? Fragment<S, Selection, Args extends [] ? NoArguments : Extract<Args[0], object>>
    : never;

/** Arguments are inferred from defaults or an annotation on the second callback
 * parameter. Definitions own no client, cache, subscription or IO.
 */
export function defineFragment<
    S extends Source[string],
    Selection extends SelectObject,
    Args extends unknown[],
>(
    source: S,
    selection: (row: RowRef<S>, ...args: Args) => Selection,
    options?: FragmentOptions<S>
): FragmentFromArguments<S, Selection, Args> {
    type Arguments = Args extends [] ? NoArguments : Extract<Args[0], object>;
    const primaryKey = (source as { readonly primaryKey?: string }).primaryKey;
    const selectKey = options?.key ?? ((row) => (row as Record<string, unknown>)[primaryKey ?? "$key"]);
    const alias = `fragment:${crypto.randomUUID()}`;
    const includeKey = (key: unknown, ...[args]: FragmentCall<Arguments>): FragmentInclude<Selection> => {
        const q = new Query();
        // Always supply an object, even when the consumer omits optional arguments.
        const resolved = [{ ...args }] as unknown as Args;
        const query = q
            .from({ [alias]: source })
            .where((refs) =>
                eq(
                    selectKey(refs[alias] as RowRef<S>) as Parameters<typeof eq>[0],
                    key as Parameters<typeof eq>[1]
                )
            )
            // Arguments are captured in the native query, never in mutable definition
            // state. Different bindings can coexist for the same source object.
            // Nested queries must use TanStack's include/materialize/toArray operator.
            .select((refs) => selection(refs[alias] as RowRef<S>, ...resolved) as never);
        return fragmentInclude(query) as unknown as FragmentInclude<Selection>;
    };
    /** A native correlated include: readers receive zero or one selected rows.
     * The enclosing query owns its execution, lifetime and shared source demand.
     */
    const includeSelection = (
        row: RowRef<S> | FragmentQuery<S>,
        ...call: FragmentCall<Arguments>
    ): FragmentInclude<Selection> => {
        if (row instanceof Query) {
            const resolved = [{ ...call[0] }] as unknown as Args;
            return fragmentInclude(
                (row as FragmentQuery<S>).select(
                    ({ row }) => selection(row as RowRef<S>, ...resolved) as never
                )
            ) as unknown as FragmentInclude<Selection>;
        }
        return includeKey(selectKey(row as RowRef<S>), ...call);
    };
    return { source, include: includeSelection } as FragmentFromArguments<S, Selection, Args>;
}

type ListFragment<S extends Source[string], Result extends Context, Args extends object> = {
    readonly source: S;
    readonly query: (scope: FragmentQuery<S>, ...args: FragmentCall<Args>) => QueryBuilder<Result>;
    readonly include: (
        scope: FragmentQuery<S>,
        ...args: FragmentCall<Args>
    ) => ReturnType<typeof include<Result>>;
};

/** Reusable list filtering, ordering and row selection over parent-owned membership.
 * A limit sets the initial page size. The list reader owns subsequent windows.
 */
export function defineListFragment<S extends Source[string], Result extends Context, Args extends unknown[]>(
    source: S,
    selection: (scope: FragmentQuery<S>, ...args: Args) => QueryBuilder<Result>
): Args extends [] | [args?: object]
    ? ListFragment<S, Result, Args extends [] ? NoArguments : Extract<Args[0], object>>
    : never {
    type Arguments = Args extends [] ? NoArguments : Extract<Args[0], object>;
    const query = (scope: FragmentQuery<S>, ...[args]: FragmentCall<Arguments>) =>
        selection(scope, ...([{ ...args }] as unknown as Args));
    return {
        source,
        query,
        include: (scope: FragmentQuery<S>, ...args: FragmentCall<Arguments>) =>
            fragmentInclude(query(scope, ...args), true),
    } as Args extends [] | [args?: object]
        ? ListFragment<S, Result, Args extends [] ? NoArguments : Extract<Args[0], object>>
        : never;
}

type FragmentLike = { include: (...args: never[]) => ReturnType<typeof include> };
export type FragmentData<F extends FragmentLike> = GetResult<ReturnType<F["include"]>["_context"]>;
/** The native include collection. Use TanStack's existing query hooks to read it. */
export type FragmentRef<F extends FragmentLike> = Collection<FragmentData<F>>;
export type FragmentCollection<F extends FragmentLike> = Collection<FragmentData<F>>;
export type ListFragmentRef<F extends FragmentLike> = Collection<FragmentData<F>>;
export type ListFragmentData<F extends FragmentLike> = FragmentData<F>;
