# Installation-owned ontology sessions and reopening

## Status

Draft proposal, not an implemented API. This is separate from the persistence
resolver changes and complements
[Collection persistence and schema evolution](../2026-10-06-collection-schema-evolution/README.md).
Start with manual reopening; schema-change detection can invoke the same lifecycle
later. Application data migrations and individual object collection replacement
remain outside this proposal.

## Goal

Allow an installation to replace an opened live ontology while retaining the
user's connection, durable local data, and pending durable writes. Consumers must
stop using the old ontology and reconnect to the replacement together. A React
page can show a loading screen during replacement and remount its ontology-dependent
subtree when the new instance is ready.

Existing `openOntology()` returns a cached `LiveOntology` instance directly. It
does not notify callers when that instance is closed or replaced. Introduce a
stable observable session that owns successive instances instead of mutating a
`LiveOntology` or swapping entries in `ontology.objects` in place.

## Proposed session API

```ts
const session = installation.ontology({ userId, ontologyId });

session.subscribe(listener); // returns unsubscribe
session.getSnapshot();
await session.reopen();
```

Snapshots are immutable and retain object identity until state changes:

```ts
type OntologySessionSnapshot =
    | { status: "opening" | "reopening"; generation: number }
    | { status: "ready"; generation: number; ontology: LiveOntology }
    | { status: "error"; generation: number; error: unknown }
    | { status: "closed"; generation: number };
```

The installation shares a session for a user/ontology pair. Metadata sessions
have separate identities and can remain open while the application session
reopens. Generation identifies an instance lifetime; it is not a schema version
and does not change persisted collection IDs.

Subscriptions provide notifications; consumer leases separately track ownership
of a ready generation. A consumer releases its lease only after its queries,
effects, and other ontology-dependent work have detached. React bindings manage
these leases; programmatic consumers need an equivalent explicit contract.
Exact acquisition/start/close APIs and how they coexist with `openOntology()`
remain design decisions. Do not acquire ownership or start openings as side
effects of React render.

## Reopen lifecycle

1. Publish `reopening`, fence new old-generation work, and notify consumers.
2. Consumers detach the old generation. Wait for actual lease release and
   asynchronous query teardown; notification alone is not an unmount barrier.
3. Settle or safely stop in-flight work and clean up the old ontology. Retain
   queued durable writes and local storage; use `cleanup()`, not `destroy()`.
4. Rerun route configuration and create a fresh runtime/ontology using the same
   owner and namespace. Configuration may supply updated IR and per-type versions
   once that version input exists.
5. Wait for readiness required for safe consumption, then publish a new ready
   generation. Do not preload every on-demand dataset merely to reopen.

Existing persistence mismatch policies determine which caches reset. Unchanged
collections reuse durable state; incompatible refetchable caches may reset and
resync. Local-only mismatches remain errors unless a migration exists. Reopening
does not make previously queued actions compatible with a changed backend schema.

Reopens serialize per session. Duplicate manual requests may coalesce; a newer
configuration revision arriving during reopening must not be silently lost.
Disconnect, session close, and installation cleanup supersede pending openings.
Late results are cleaned up rather than published. Failures publish `error` and
support explicit retry after safe teardown; do not restore references to a cleaned
old instance or open another writer while prior teardown is unresolved.

## React boundary

Place one boundary above the subtree that depends on the ontology. It subscribes
using `useSyncExternalStore`. Non-ready snapshots render loading/error/closed
content without the old subtree; ready snapshots render a provider keyed by
generation:

```tsx
// Conceptual rendering; ownership leases and teardown acknowledgements omitted.
if (snapshot.status !== "ready") {
    return <OntologySessionStatus snapshot={snapshot} />;
}

return (
    <OntologyProvider key={snapshot.generation} ontology={snapshot.ontology}>
        {children}
    </OntologyProvider>
);
```

State above the boundary survives. State inside it resets, including component
form state; drafts that must survive belong outside that lifetime or in durable
storage. All consumers of the old generation must participate, including portals
and background consumers outside the visible page.

Suspense may handle initial/new-generation loading, but hiding an existing tree
does not guarantee unmount or subscription release. An explicit non-ready gate
provides the intended teardown. Never clean collections immediately after
publishing `reopening` and assume React has committed its detach.

Scope retained live-query identities by session generation, or invalidate their
generation-owned cache, so remounting cannot recover queries attached to old
same-ID collection instances. The React binding must verify this against the
TanStack versions in use. See
[React Suspense](https://react.dev/reference/react/Suspense),
[useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore), and
[TanStack DB #1991](https://github.com/TanStack/db/issues/1991).

## Ownership, validation, and open decisions

Release listeners, generation leases, retained promises, and old ontology
references when their lifetimes end. Session retention must follow explicit
ownership and installation cleanup, not an unlimited registry of historical
sessions or generations. A leaked consumer lease must have an observable failure
or diagnostic path rather than a silent permanent loading state.

Test manual reopen, shared consumers, UI detach ordering, query cache isolation,
pending durable writes, construction/cleanup failures, repeated requests, updated
configuration during opening, disconnect/close races, and stale asynchronous
results. React tests should include multiple live queries and Strict Mode lifecycle
replay.

Open decisions: public session ownership APIs; the consumer teardown barrier;
generation-aware query integration; retry behavior after teardown failure; schema
change signals and coalescing; and cross-context invalidation. A local session
reopen does not by itself retire old writers in other tabs or workers. Schema
upgrades affecting shared storage must also honor coordination and stale-adapter
fencing.
