# Dependency patches

Flag every new dependency patch to the user, including its package, behavior and
reason. The publishable [tanstack-db-patches package](../packages/tanstack-db-patches/README.md)
owns both patch files and provides a bundled Effect setup CLI. This workspace
registers those same files through native pnpm `patchedDependencies`, with no
custom `.pnpmfile.cjs`.
Consumers of published Party Stack libraries do not inherit workspace install
settings: run setup in each consumer repository. Version `0.1.0` is
currently unpublished; its README documents tarball use and future registry setup.

## `@tanstack/react-db@1.0.0-rc.1.4`

Explicitly approved on November 8, 2026. Browser Suspense queries now start through
the observer's explicit preload before their first snapshot. Previously a
DbClient-backed graph started before preload registered demand, making a
synchronous on-demand answer suspend unnecessarily.

The patch also keeps failed initial queries in the native Suspense retry registry
until normal collection cleanup. A zero-delay removal could discard their errors
before React retried, repeatedly starting a failing load instead of reaching the
error boundary.

It changes `useLiveQuery.ts`, `useLiveSuspenseQuery.ts` and their published ESM/CJS
equivalents. It keeps the native Suspense binding, asynchronous loading and server
admission/hydration paths. Source-map directives are removed from the four modified
distribution files because their shipped maps describe the original code.

Readiness, StrictMode, asynchronous loading, errors and SSR/hydration regressions
live in `packages/ontology-react/src/*readiness*` and `query-lifecycle.browser.test.ts`.
Remove the patch when an upstream release passes those regressions unmodified.

## `@tanstack/db@1.0.0-rc.1.4`

Explicitly approved on November 9, 2026. Adds the optional adapter declaration
`sync.supportsOrderedWindow(options)` for exact finite prefixes under the full
ordering. Party Stack derives its declaration from typed ontology metadata:
filters and ordering must push down exactly, comparisons must match, and the
ordering must end in the non-null primary key.

Admitted direct queries use the existing bounded-prefix acquisition and repair
paths, compare the complete ordering, and skip the leading-field tie request.
For example, a 51-row page ordered by `updatedAt, id` no longer falls back to
loading every note because `Temporal.Instant` cannot form DB's scalar cursor.
Window growth rereads a larger prefix; this patch adds no composite cursor,
index, query-result cache, or new transport.

Absent or declined declarations preserve DB's conservative loading. Joins,
residual filters, computed sorts, unsupported comparison domains and incompatible
merged source views retain their existing fallback. An admitted window moved to
a negative offset uses the full-source path. Existing optimistic headroom, request receipts, invalidation,
cancellation, ownership and retry machinery still apply.

The patch touches three modules: `types.ts`, `query/compiler/order-by.ts` and
`query/live/ordered-source-loader.ts`, plus their published ESM/CJS runtime and
declaration equivalents. Source-map directives are removed from the four edited
runtime files because their shipped maps describe the original code.

Regressions live in `packages/ontology/src/tanstack/ordered-window.test.ts` and
`orderedWindow.contract.test.ts`: typed admission, timestamp and boolean orders,
window growth, mixed-domain fallback, optimistic rollback and confirmation,
invalidation, late receipts, retry and scoped release. The upstream proposal is
in [tanstack-db-ordered-window.md](./tanstack-db-ordered-window.md).

Remove this patch after an upstream release supports
the same exact ordered-prefix contract and passes those regressions unmodified.
Keep the adapter declaration if upstream adopts the same API; adapt or remove it
only if upstream supplies an equivalent automatic capability.
Related upstream reports: [#2166](https://github.com/TanStack/db/issues/2166) and
[the current leading-column strategy](https://github.com/TanStack/db/pull/1893).
Upstream reports: [React synchronous readiness #2396](https://github.com/TanStack/db/issues/2396),
[React initial acquisition failures #2397](https://github.com/TanStack/db/issues/2397),
and [exact ordered prefixes #2398](https://github.com/TanStack/db/issues/2398).

No Base UI dependency patch is active.

## Effect TypeScript/Oxlint tooling

The root `prepare` script also runs `effect-tsgo patch --oxlint`, supplied by
`@effect/tsgo@0.53.4`. This patches the installed native TypeScript and Oxlint
toolchain to provide Effect diagnostics. It is a vendor-provided development
tooling patch, not a local pnpm patch file or application runtime change. Effect
lint presets are configured through `@party-stack/build-config/effect`.

## Fragment runtime compatibility adapter

`packages/db-fragments/src/runtime.ts` wraps the include materializer for individual
fragment queries and reads internal parent-correlation metadata. This lets
`useListFragment` create an independently paginated root query over the original
sources while TanStack lacks child-collection window controls. It does not modify
the global runtime or installed dependency files, but it is coupled to the pinned
DB RC's internals. Unlike workspace pnpm patches, this adapter ships in
`@party-stack/db-fragments`; it should be replaced when native child pagination
provides the same behavior.
