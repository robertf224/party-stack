import { BaseQueryBuilder, include, includesRuntime, IR, isCollection } from "@tanstack/db";
import type { Collection, Context, IncludesRuntime, QueryBuilder } from "@tanstack/db";

type Compilation = Parameters<IncludesRuntime["materializeCompilation"]>[0];
type CompiledInclude = NonNullable<Compilation["includes"]>[number];
type Facades = NonNullable<ReturnType<IncludesRuntime["materializeCompilation"]>["facades"]>;
type Route = {
    active: boolean;
    correlationKey: unknown;
    parentContext: null | {
        value?: Record<string, unknown>;
        projectedBindings?: Record<string, unknown>;
    };
};
export type ListRecipe = { query: QueryBuilder<Context>; pageSize: number };

const recipes = new WeakMap<object, ListRecipe>();
const preparedListPageSizes = new WeakMap<object, number>();
const installedWindows = new WeakSet<object>();
const templates = new WeakMap<IncludesRuntime, IR.QueryIR>();
const materializations = new WeakMap<Facades, { root: Compilation; scopes: Map<string, Compilation> }>();
const passthrough = new WeakSet<Facades>();
const incompatible = () =>
    new Error("TanStack DB's include internals changed. db-fragments cannot bind this list safely.");

/** Compatibility boundary for DB 1.0 RC. Keep all materializer reflection here.
 * No global runtime is modified; the native graph still owns child collections.
 * Weak maps retain plans/bindings only, never another copy of result rows.
 */
const runtime: IncludesRuntime = {
    ...includesRuntime,
    materializeCompilation(compilation, ...args) {
        const seen = new Set<Compilation>();
        const containsList = (scope: Compilation): boolean => {
            if (seen.has(scope)) return false;
            seen.add(scope);
            return (
                scope.includes?.some(
                    (entry) => templates.has(entry.runtime) || containsList(entry.childCompilationResult)
                ) ?? false
            );
        };
        // Ordinary singular fragment trees, including the independently rooted
        // list's row fragments, use the unmodified native adapter.
        if (!containsList(compilation)) {
            const result = includesRuntime.materializeCompilation(compilation, ...args);
            if (result.facades) passthrough.add(result.facades);
            return result;
        }
        const created: Compilation[] = [];
        const scopes = new WeakMap<Compilation, Compilation>();
        const instrument = (scope: Compilation): Compilation => {
            const cached = scopes.get(scope);
            if (cached) return cached;
            const children = scope.includes?.map(
                (entry) =>
                    new Proxy(entry, {
                        get(target, key, receiver) {
                            if (key === "childCompilationResult")
                                return instrument(target.childCompilationResult);
                            // Native materialization visits this branch once per newly
                            // created Collection edge, including empty buckets. Observe
                            // its actual traversal rather than guessing from field names.
                            if (key === "materialization" && target.materialization === "collection")
                                created.push(target.childCompilationResult);
                            return Reflect.get(target, key, receiver);
                        },
                    })
            );
            const proxy = new Proxy(scope, {
                get(target, key, receiver) {
                    return key === "includes" ? children : Reflect.get(target, key, receiver);
                },
            });
            scopes.set(scope, proxy);
            return proxy;
        };
        const result = includesRuntime.materializeCompilation(instrument(compilation), ...args);
        if (result.facades) {
            if (result.facades.length !== created.length) throw incompatible();
            materializations.set(result.facades, {
                root: compilation,
                scopes: new Map(result.facades.map((facade, i) => [facade.edgeId, created[i]!])),
            });
        }
        return result;
    },
    createBucketFacades(...args) {
        if (passthrough.has(args[1])) return includesRuntime.createBucketFacades(...args);
        const info = materializations.get(args[1]);
        if (!info) throw incompatible();
        const listEntries = new Map(
            [info.root, ...info.scopes.values()].map((scope) => [
                scope,
                scope.includes?.filter((entry) => templates.has(entry.runtime)) ?? [],
            ])
        );
        const attach = <T>(scope: Compilation, value: T, resolved: T): T => {
            if (!value || typeof value !== "object") return resolved;
            const lists = listEntries.get(scope) ?? [];
            if (!lists.length) return resolved;
            const symbol = Reflect.ownKeys(value).find(
                (key) => typeof key === "symbol" && key.description === "includesRouting"
            );
            if (!symbol) throw incompatible();
            const routes = Reflect.get(value, symbol) as Record<string, Route>;
            for (const entry of lists) {
                const route = routes[entry.fieldName];
                if (!route?.active) continue;
                const child = entry.resultPath.reduce<unknown>(
                    (part, key) => (part && typeof part === "object" ? Reflect.get(part, key) : undefined),
                    resolved
                );
                if (!isCollection(child)) throw incompatible();
                const collection = child as Collection<object>;
                if (!recipes.has(collection)) {
                    const bound = bind(templates.get(entry.runtime)!, entry, route);
                    recipes.set(collection, {
                        query: new BaseQueryBuilder(bound),
                        pageSize: pageSize(bound),
                    });
                }
            }
            return resolved;
        };
        // RC.1.4 resolves only compiled include paths. Observe each scope's
        // explicit resolver instead of intercepting private facade methods.
        // The native adapter still owns row memoization and child publication.
        type Resolver = Parameters<IncludesRuntime["createBucketFacades"]>[3];
        const wrap =
            (scope: Compilation, resolve: Resolver): Resolver =>
            (value, resolveFacade) =>
                attach(scope, value, resolve(value, resolveFacade));
        return includesRuntime.createBucketFacades(
            args[0],
            args[1].map((facade) => ({
                ...facade,
                resolve: wrap(info.scopes.get(facade.edgeId)!, facade.resolve ?? args[3]),
            })),
            args[2],
            wrap(info.root, args[3])
        );
    },
};

/** Original sources stay source objects; literals stay literal values. Only IR
 * expressions are rewritten. In particular, don't traverse rows held by a source
 * or encrypted/temporal values held inside IR.Value.
 */
function bind(template: IR.QueryIR, entry: CompiledInclude, route: Route): IR.QueryIR {
    const parentValues = new Map<string, unknown>();
    const key = (ref: IR.PropRef) => JSON.stringify([ref.bindingId ?? ref.path[0], ref.path.slice(1)]);
    parentValues.set(key(entry.correlationField), route.correlationKey);
    for (const ref of entry.parentProjection ?? []) {
        const projected = route.parentContext?.projectedBindings;
        const bindingKey = JSON.stringify([ref.bindingId, ref.path.slice(1)]);
        if (projected && Object.hasOwn(projected, bindingKey)) {
            parentValues.set(key(ref), projected[bindingKey]);
        } else {
            const value = ref.path.reduce<unknown>(
                (part, field) => (part && typeof part === "object" ? Reflect.get(part, field) : undefined),
                route.parentContext?.value ?? route.parentContext
            );
            parentValues.set(key(ref), value);
        }
    }
    const rewrite = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return value;
        if (value instanceof IR.PropRef)
            return parentValues.has(key(value)) ? new IR.Value(parentValues.get(key(value))) : value;
        if (
            value instanceof IR.Value ||
            value instanceof IR.CollectionRef ||
            value instanceof IR.DescriptorRef
        )
            return value;
        if (value instanceof IR.QueryRef)
            return new IR.QueryRef(rewrite(value.query) as IR.QueryIR, value.alias, value.bindingId);
        if (Array.isArray(value)) return value.map(rewrite);
        // Runtime operators and their closures are not query expressions.
        const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
        for (const [name, field] of Object.entries(value))
            copy[name] = name === "runtime" || name === "grouping" ? field : rewrite(field);
        return copy;
    };
    return rewrite(template) as IR.QueryIR;
}

export function pageSize(query: IR.QueryIR): number {
    const size = query.limit ?? 50;
    if (!Number.isSafeInteger(size) || size < 1)
        throw new Error("A list fragment limit must be a positive integer.");
    return size;
}

export function initialListQuery<Result extends Context>(query: QueryBuilder<Result>) {
    const builder = query as BaseQueryBuilder<Result>;
    const ir = builder._getQuery();
    if (!ir.orderBy?.length) throw new Error("Paginated list fragments require an orderBy clause.");
    if (ir.singleResult || ir.offset)
        throw new Error("List fragments require a plural query starting at offset zero.");
    return builder.limit(pageSize(ir) + 1);
}

export function fragmentInclude<Result extends Context>(
    query: QueryBuilder<Result>,
    list = false
): ReturnType<typeof include<Result>> {
    const wrapper = include(
        list
            ? (query as BaseQueryBuilder<Result>).limit(
                  pageSize((query as BaseQueryBuilder<Result>)._getQuery())
              )
            : query
    );
    const ownRuntime = Object.create(runtime) as IncludesRuntime;
    if (list) {
        // Validate pagination before the parent starts acquiring data.
        initialListQuery(query);
        templates.set(ownRuntime, (query as BaseQueryBuilder<Result>)._getQuery());
    }
    Reflect.set(wrapper, "runtime", ownRuntime);
    return wrapper;
}

export function listRecipe(collection: object): ListRecipe | undefined {
    return recipes.get(collection);
}

export function setPreparedListPageSize(collection: object, size: number): void {
    preparedListPageSizes.set(collection, size);
}

export function preparedListPageSize(collection: object): number | undefined {
    return preparedListPageSizes.get(collection);
}

/** A native window that was once ready retains its own accepted result during
 * later page failures. Do not replace it with the parent's shorter first page.
 * This monotonic readiness witness holds no rows and does not require a React
 * state/effect render just to remember a native publication already observed.
 */
export function hasInstalledWindow(collection: object, ready: boolean): boolean {
    if (ready) installedWindows.add(collection);
    return installedWindows.has(collection);
}
