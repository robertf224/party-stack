# Component fragments

`defineFragment` defines a selection over a TanStack DB collection or collection
descriptor. It adds no cache or subscription. `.include` uses TanStack DB 1.0's native
`include` to put a reactive child collection in the query result.

```tsx
import { defineFragment, type FragmentRef } from "@party-stack/db-fragments";
import { useFragment } from "@party-stack/db-fragments/react";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { objects } from "./ontology/generated/collections";

const card = defineFragment(objects.Issue, (issue) => ({
    title: issue.title,
    status: issue.status,
}));

function Issues() {
    const { data } = useLiveSuspenseQuery((q) =>
        q.from({ issue: objects.Issue }).select(({ issue }) => ({
            id: issue.id,
            card: card.include(issue),
        }))
    );
    return data.map((issue) => <Card key={issue.id} issue={issue.card} />);
}

function Card({ issue }: { issue: FragmentRef<typeof card> }) {
    const { data: value } = useFragment(issue);
    return value ? <h2>{value.title}</h2> : null;
}
```

The parent owns membership, ordering and the lifetime of its includes. A fragment
receives zero or one row, keyed by the source's primary key. Deleting that object
empties the child collection. Unselected property changes do not change its data.

## Keys and relationship helpers

`defineFragment(source, selection, options?)` accepts a native Collection or a
TanStack collection descriptor. Its returned `.source` is that exact argument;
it does not resolve a descriptor, acquire a collection, or load data. Definitions
can be shared across clients. The only definition option is an optional correlation
selector:

```ts
const card = defineFragment(notes, (note) => ({ title: note.title }), {
    key: (note) => note.id,
});
```

Keys are chosen in this order:

1. The explicit `options.key` expression, if supplied.
2. A descriptor's `primaryKey` string, such as `"id"`.
3. TanStack's virtual `$key`, which uses the collection's existing `getKey` identity.

Party Stack's generated descriptors supply the `primaryKey` metadata. It is a
field name, not another key getter. Generic collections need no extra metadata;
an explicit selector is useful when correlation should use an indexed field or
a different property. It does not replace the collection's `getKey`. Non-unique
correlation values can match multiple rows, which `useFragment` rejects.
The current TanStack RC does not automatically index virtual `$key` predicates.

Relationship helpers are ordinary query builders, not a separate fragment
protocol. Party Stack's generated descriptors expose declared links:

```ts
userCard.include(objects.Issue.links.assignee(issue));
```

That helper returns a native query over the target descriptor, using the alias
`row` and a predicate correlated with `issue`. `db-fragments` does not inspect a
`.links` property or need to know which package supplied the helper. Any app can
provide the same query directly:

```ts
userCard.include(new Query().from({ row: objects.User }).where(({ row }) => eq(row.id, issue.assigneeId)));
```

Selections can nest other fragments or native `include` queries.

Names are internal. Descriptors resolve through the
enclosing query's DbClient, so the same definition can serve separate users.
Fragment types limit component inputs; authorization still belongs on the server.

Fragment callers do not need to thread a query builder through refs. A callback
that authors its own nested query can use TanStack's `new Query()`.

`@party-stack/ontology-react` re-exports these helpers.

## Arguments

Arguments are inferred from defaults on the callback's second parameter:

```tsx
import { defineFragment } from "@party-stack/db-fragments";

const card = defineFragment(objects.Issue, (issue, { includeStatus = true }) => ({
    title: issue.title,
    ...(includeStatus ? { status: issue.status } : {}),
}));

// In a parent's selection:
card.include(issue); // includeStatus defaults to true
card.include(issue, { includeStatus: false });
```

An optional argument with no default can use `query = undefined as string | undefined`.
For a required argument or a constrained type, annotate the parameter directly:

```tsx
type Args = { label: string; includeStatus?: boolean };

const card = defineFragment(objects.Issue, (issue, args: Args) => ({
    title: issue.title,
    label: args.label,
}));
```

Required properties make the argument object required. A parent fragment can forward or
bind arguments when composing its children. Each reference captures its own
bindings; two references to the same object can select different data. Arguments
are query-construction inputs: change them through the enclosing live query.
They do not create another subscription or a mutable fragment variable store.
Conditional selections have optional fields in the resulting data type.

## Reading

`useFragment` subscribes directly to a singular included collection and uses
Suspense for initial readiness. It returns `{ data }`, containing the selected value or `undefined`
after deletion. Multiple matches are an error. For a plural include, use
`useLiveSuspenseQuery(collection)` to read its array of rows.

Native included collections currently expose their own health but omit their
source dependencies. As a result, `useLiveSuspenseQuery(ref).health` cannot report
an upstream sync failure; inspect the parent live query's `health` for that today.
Fixing this requires DB to attach source-health dependencies to each included
collection and relay their `health:change` events. The expected-failure browser
regression in `ontology-react` covers this gap without acquiring another query.

## Lists and links

Define a reusable list over its item collection. The parent supplies membership;
the list owns filtering, ordering and the row fragments it needs.

```tsx
const noteList = defineListFragment(objects.Note, (notes, { query = "", limit = 50 }) =>
    notes
        .where(({ row }) => ilike(row.title, `%${query}%`))
        .orderBy(({ row }) => row.favorite, "desc")
        .orderBy(({ row }) => row.updatedAt, "desc")
        .limit(limit)
        .select(({ row }) => ({ id: row.id, card: noteCard.include(row) }))
);

// In the parent's selection callback:
notes: noteList.include(objects.Notebook.links.notes(folder), { query, limit });

function NoteList({ notes }: { notes: ListFragmentRef<typeof noteList> }) {
    const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useListFragment(notes);
    return (
        <>
            {data.map((note) => (
                <NoteCard key={note.id} note={note.card} />
            ))}
            {hasNextPage && (
                <button disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                    Load more
                </button>
            )}
        </>
    );
}
```

Link helpers return native queries with the alias `row`. They work in both link
directions, including self-links and nested foreign-key paths. Extend them directly;
putting a correlated query inside another `from` hides its correlation from include.
`list.query(scope, args)` builds the same selection for an ordinary root query.
It returns a query builder without executing it or wrapping it in `include`:

```tsx
const query = noteList.query(new Query().from({ row: objects.Note }), {
    query: search,
    limit: 50,
});
const { data, fetchNextPage } = useListFragment(query);
```

Use `.include(...)` when a parent query will pass a child-list reference; use
`.query(...)` when the list is the root of the view, such as search results.

`limit` supplies the initial page size (50 when omitted). Lists require an explicit
`orderBy`; add a unique final sort key to break ties. `useListFragment` suspends for
the included first page, then uses an independent root query over the original
sources with the parent relation bound to concrete values. Its native infinite
controller grows only that reader's window, without rebuilding the parent query
or suspending for later pages. Changing arguments or the parent resets pagination.
The live included page stays visible until the new root is ready; no rows are
copied into a fragment cache. Singular fragments still read their native includes
directly. `useListFragment(list.query(scope, args))` handles a root list through the
same hook, reusing that root collection instead of constructing a second query.

The bound recipe is attached through a per-query materializer adapter for the pinned
TanStack DB RC. This adapter does not patch DB core or a global runtime. Compose the
outer tree with fragment `.include` helpers: a native `include()` chosen first by
an outer query can bypass the adapter. Missing metadata produces an explicit error.
Compatibility tests cover nested includes, repeated field names, separate clients,
parent filters, empty lists, relationship moves, argument changes and cleanup.

Re-rooting costs an extra live query per mounted included-list reader. Source data
and replica coverage remain shared. The initial grouped include can still overfetch:
the current DB compiler does not push per-parent limits into source acquisition.
This implementation provides independent windows, not a promise of bounded initial
provider reads. A future native child-window controller can replace the adapter.

## Suspense queries

Import root query hooks directly from `@tanstack/react-db`. This package exports
only `useFragment` and `useListFragment` from its React entry point; those hooks
also use TanStack's native query hooks internally.

Configure query retention through TanStack's native `gcTime` option. Keeping an
unused graph alive can preserve incremental join, filter, and sort results, but
also keeps its subscriptions active. This is separate from retaining source rows
or a replica's offline cache. Fragment hooks do not override TanStack's retention
defaults, and borrowed collections retain their own configuration.

The native hook owns the query graph, subscription, Suspense retries and initial
errors. Server rendering and hydration retain the same query identity. This adds
no row cache. Included fragments read their existing collections directly.

This workspace currently carries an explicitly approved React DB patch for false
initial suspension and initial-error retry lifetime; see [dependency patches](../../patches/README.md).
Published consumers do not inherit workspace pnpm patches. Retention options
alone do not fix upstream startup behavior.

## Route loaders and server rendering

Read queries inside the provider with TanStack's `useLiveSuspenseQuery`.
`useFragment` and `useListFragment` use the same native Suspense lifecycle. Query
preloading and route-ownership helpers are not part of this package's public API.

For browser replicas in TanStack Start, set `ssr: false` on the route that owns the
ontology provider. This opens the local replica in the browser and leaves live
query subscriptions with their components. An acquired ontology or live Collection
cannot be serialized as loader data and transferred from server to browser.

Native scalar-query SSR uses TanStack's request-scoped DbClient and
preload/dehydrate/hydrate or streaming integration. See the
[TanStack SSR guide](https://tanstack.com/db/latest/docs/guides/ssr).
Nested fragment results are not currently supported by that snapshot path: native
includes contain live child Collections, and included readers need additional
server-snapshot admission/hydration support. A complete replica-aware SSR and
preloading integration is deferred until those boundaries are addressed together.
