# Ontology devtools

`createOntologyDevtoolsPlugin({ ontology })` inspects a LiveOntology. Object inspection
uses persisted collections; opening the inspector does not create backend demand.

## Style isolation

The panel renders in an open shadow root with its compiled stylesheet and local
reset. Host application selectors cannot override its controls, tables or icons;
the stylesheet is no longer injected into the application document. The plugin and
standalone `OntologyDevtoolsPanel` use the same boundary.

Menus, tooltips, attachment dialogs and component highlights portal into a second
styled shadow root mounted under the document body. This lets overlays escape the
devtools shell's clipping while keeping their styles private. The highlight keeps
its low stacking order beneath the panel. Both roots retain the React context;
closing the panel removes its overlay host and subscriptions. The panel is mounted
on the client, so server rendering does not access browser DOM APIs.

## Tracing

Tracing shows a sortable table of top-level operations, with status colors and operation icons.
Enable **Child spans** to expand nested operations in the table, or select an
operation to inspect its waterfall subtree in a bounded details drawer. The waterfall appears only in details. The drawer overlays
the table without changing its columns or viewport size. Pause freezes the recorded
spans, requests, and clock; Resume live follows incoming records. Request details
use real trace/span IDs to correlate queries with loads.

Pure Effect interruption is shown neutrally as **Stopped** for a subscription or
**Cancelled** for an operation. Unsubscribing or closing a scope is not an error.
A cause containing both interruption and an error/defect remains **Failed**.
Details explain cancellation and show real failures with their error message when
available, capped at 500 characters. Traces retain no error stack, cause object or
arbitrary error payload; older records without a captured message say so explicitly.

Subscription status and event counts appear in the table; watch and demand
lifetimes do not affect request waterfall details.
The Events column counts recorded span events; selecting a watch shows its actual
subscribed, invalidation and disconnected events. It does not count raw network frames.
Each span retains at most 100 events and a total count; arbitrary event names and
attributes are excluded from this diagnostic buffer. These are invalidation hints,
not copies of row payloads or network frames.

The source selector applies only to Tracing: **This tab** and, when present,
**Shared worker** (or the parent's actual location). Queries, Objects and Outbox
continue to reflect the current LiveOntology. The in-process fallback shows only
**This tab**, with no upstream selector. A missing parent trace store never falls
back to showing the child's spans under a parent label.

## Queries

Queries shows current demand from the local LiveOntology, with object type icons and
names as part of each query, distinct field/operator/literal tokens, indented boolean
groups, sort order, limits, cursor/pagination and component counts.
Field display names come from the ontology definition; AND, OR and NOT grouping is
preserved. Default null placement (first ascending, last descending) is omitted;
nondefault placement is shown. Missing/undefined and explicit null values use muted
special-value tokens. LIKE/ILIKE patterns highlight `%` and `_` wildcard characters.
This view is named Queries so richer query definitions can grow into it.
Demand leases retain query consumers; row GC remains mark-and-sweep. Subscription
and watcher counts are omitted from the inspector; it shows attributed components.

The main query shows the original source request from TanStack when attribution is
available. Its header names up to three component types, grouping mounted instances
as `IssueList ×2`, then counting remaining instances as “and N other components”.
Expand **Pushdown** for the request path, for example **Query → Tab replica →
Shared worker replica → Foundry**. The detailed sections distinguish translation
into the tab replica's query from the shared replica's source request. Without a
parent, both happen in this tab. Broader replica requests are shown explicitly;
inline sentences explain filtering, sorting and limits that stay in the tab or
adapter. This is per-source demand, not the entire join query.

Adapters report placement against paths in the portable predicate tree:
**Pushed down** means a native condition, **Approximate pushdown** means source
narrowing followed by exact adapter filtering, and **Not pushed down** means
filtering only after the source returns rows. The summary describes filter pushdown;
it does not imply that sorting or pagination was also pushed down. An unsupported
branch inside OR can force the whole OR to remain in the adapter; supported siblings
must not be labeled as sent when they were dropped. A redundant adapter filter check
is omitted in the normal case; required residual filtering and adapter pagination
remain explicit. The renderer has no provider-specific expression parser. Optional
native JSON/SQL is displayed in a syntax-highlighted code block inside the **Native
query** disclosure, preserving its source text. Unknown formats use plain text;
highlighting never determines query execution or pushdown. Missing
reports are explicitly identified; these plans are diagnostic metadata, not a
capability/coverage contract.

The requested row limit stays with the query clauses. Matching fetched/returned
counts become one line, such as **Loaded 2 rows**. Different counts
show the source response and rows sent to the named receiving replica, with the
reported adapter processing between them. In a shared-worker setup this is the
worker replica importing its source response, before replication to the tab. These
are counts for the latest exact-query request, not current collection sizes or
database rows scanned. When the source count is unavailable, only the returned count
appears. Missing exact telemetry does not establish a cache hit or imply zero rows:
covering requests and eviction from the 100-call buffer can also prevent a match.
When the engine's last completed demand check explicitly reports `coveredBy`, the
inspector instead explains which maintained query supplied the existing data and
which replica reused it. This proof travels through the read-only status stream;
the UI never infers reuse just because a broad request exists in load history.
Queries reflect the tab even when load statistics come from its worker.

## Schema

The read-only schema explorer uses React Flow for pan, zoom, fit-to-view and node
selection, with Dagre positioning. It refits after panel sizing settles. Each edge
shows just one cardinality label in its arrow's direction, such as **one-to-many**
for Project → Issue. Endpoint markers and relationship names are omitted from the
graph. Arrows run from the referenced object to its dependents. This presentation reverses
the IR's FK direction, **Issue.projectId → Project**. A link's source side names the
Issue end and its target side names the Project end; `cardinality` counts sources
per target. In the selected object's details, side display names are used as declared, with the object's plural name
as a fallback when a many-side label only repeats its singular object name. Custom
relationship labels are preserved. Select an object card to inspect all property
types, its primary key, and relationships. Node dragging changes only the diagram.
The tab order is Objects, Outbox, Queries, Tracing, Schema; Objects opens by default.

### Highlighting query consumers

Enable the optional development-only Vite plugin in the application:

```ts
import { demandAttribution } from "@party-stack/ontology-devtools/vite";

export default defineAppConfig({ plugins: [demandAttribution()] });
```

Issue-tracker enables it. Attributed query cards show a component count. Hover or
keyboard focus highlights their mounted component regions; click, Enter, or Space
scrolls to an offscreen region. Each mounted instance has its own React ID, so a
shared query retains all its consumers. Registrations follow committed hook results
and are removed on unmount or query replacement, including React Strict Mode cleanup.

The initial transform covers named `useLiveQuery`, `useLiveInfiniteQuery`, and
`useLiveSuspenseQuery` imports (including aliases) called directly inside named
React function components. It tags native JSX elements, including elements in
fragments and portals, without changing refs or query arguments. Components that
only return other components have no native region to highlight. Custom-hook
indirection, namespace imports and unnamed components are not yet instrumented.
Source locations supplement instance identity; they are not the highlight target.
The highlight excludes devtools and its enclosing containers, and sits below the
devtools panel. Hover anywhere on a card to preview; the query itself is a keyboard
and click target. Issue-tracker's profile identity owns a primary-key user demand
directly, providing a small component example alongside its broader page queries.

Attribution reads existing collection subscriptions and matches their exact subset
requests. It never subscribes, reads rows or acquires extra demand. The private
TanStack DB 0.14 graph inspection is isolated in `attribution/tanstack.ts`, covered
by an integration test, and fails closed on unknown shapes. Unattributed demand
remains visible without guessing its component. Component metadata stays in the
tab and does not enter replication requests. The plugin only runs during Vite
serve; production builds do not inject helpers or DOM tags. Server rendering can
import the helpers safely; registration happens only after client commit.

## Diagnostic transport

Diagnostics retain the latest 100 upstream calls and a lifetime count in memory,
including calls made before opening the panel. They capture query predicates and
failure messages, but never returned rows, invocation parameters or blob bytes.
The server authorizes the `ReplicaStatus` helper RPC independently of query/state-
transfer permissions. Traces and status use read-only helper streams on the same RPC
connection, separate from the replicated row/action contract.

The core Replica exposes `status` and `statuses` as an Effect and Stream.
`LiveOntology.diagnostics` supplies scoped, lazily subscribed monitors and trace
stores. Subscribing does not wake sync or acquire subset leases; changing source or
unmounting releases the subscription. Stream failures are displayed as stale state.

Outbox entries distinguish forwarding attempts from upstream execution attempts.
The card shows **Forwarding** before parent acceptance and **Attempts: N** for the
observed executing replica. Forwarding remains Waiting; Running starts when the
executing replica dispatches upstream. Stage and action state come from one atomic
read, so worker acceptance cannot mix a new stage with an old action snapshot.
Execution attempt counts survive receipt persistence and confirmation retries.

## Example navigation lifecycle

Issue-tracker mounts the app and devtools once in a shared pathless route layout.
All Issues and Project routes change parameters within that shell. The plugin list
is memoized for the live ontology, preserving the selected devtools tab and trace
source during navigation. A full document reload or an ontology replacement still
creates a new view.
