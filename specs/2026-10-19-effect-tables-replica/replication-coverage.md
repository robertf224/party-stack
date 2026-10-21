# Coverage and replication progress

Coverage belongs to Replica. It answers whether a demand needs a remote snapshot;
it is not a time-to-live cache. A healthy change stream maintains covered data.
During startup or reconnect, persisted rows remain readable while synchronization
catches up. Neither an ordinary storage read nor devtools inspection acquires
network demand.

## Initial overlap rules

- A complete unfiltered snapshot covers every narrower query on that object type.
  Ordering without a limit, offset, or cursor still contains the whole collection.
- A confirmed primary-key lookup covers another lookup of the same key, including
  confirmed absence. A key returned by a maintained complete snapshot also proves
  coverage for that key. An optimistic row alone does not prove remote coverage.
- Exact unbounded queries remain covered through journal catch-up. Bounded queries
  retain their snapshot while the journal head is unchanged; after progress they
  can require a new snapshot to refill the window.
- Coverage survives reopening when a coordinated snapshot cursor can be maintained
  by the journal. Watch-only coverage requires a live, caught-up watcher lease;
  reopening that lease repairs its snapshot. A hint received during snapshot loading
  leaves another refresh outstanding.
- GC invalidates coverage affected by an eviction, including a key returned by an
  older snapshot that has since moved out of its filter. A cached proof cannot
  outlive the data it describes. Other overlaps remain conservative for now.

There is no separate freshness timer for covered data. Sources with neither durable
changes nor an active watcher still need polling. Watchers supply invalidation
hints; they do not manufacture durable journal cursors. The current Foundry adapter
uses this hint-and-repair path, with durable edits-history catch-up still pending.

## Action receipts and read-back

Foundry's native action path submits directly through the SDK. It no longer creates
temporary live TanStack collections or another watcher to confirm an action. The
action response requests `ALL_V2_WITH_DELETIONS` and becomes a portable receipt:
invocation ID, remote operation ID, committed/accepted outcome, attachment mappings,
and an optional complete `affected` list. Each affected entry names a modeled type
and its primary keys. Omitted keys indicate a broad type change, as with Foundry's
large-scale edits. An empty list explicitly means no modeled object changes.

Replica writes the receipt onto the durable outbox entry with state `acknowledged`
before read-back. On restart, that state resumes confirmation from the receipt;
it does not submit the action again. Identity read-back uses bounded key batches,
and Foundry pushes those keys as an `in` filter through the shared search endpoint
and pagination implementation. A complete result can establish absence; denied
reads and incomplete snapshots cannot. Broad large-scale edits retain a type-level
read-back fallback. Receipts from older adapters with no affected list retain the
existing fallback to locally touched types while those adapters are ported.

Salesforce synthesizes committed CRUD receipts from successful record API calls,
using the returned create ID or the supplied update/delete ID. These are known
targets, not a complete list of automation effects, so `affectedComplete: false`
marks the list as partial. Replica currently confirms such receipts by refreshing
all modeled types, including rows changed by automation outside the action's
local mutator. The flag and known identities remain durable across failed reads
and restart. Missing `affectedComplete` preserves complete-list semantics for
existing receipts; an omitted affected list retains the compatibility fallback
above. This conservative read-back is intentionally not a scalability endpoint.

Salesforce flows/standard actions return broad modeled-type targets. The native
binding creates no temporary TanStack collections for reads, writes or query
functions. It does not claim a durable CDC cursor or server-side invocation
deduplication. Reference: Salesforce's [Create a Record API](https://developer.salesforce.com/docs/platform/api-rest/guide/dome-sobject-create.html)
returns the created identity; a synthetic receipt does not invent a server
operation ID or journal cursor.

Read-back IO runs outside the local transaction. Once every required read is
complete, one local transaction installs confirmed rows/deletions, removes the
pending entry and its retention roots, records completion, and rebases remaining
optimistic work. A read failure or partial response leaves the receipt and pending
work durable. Publication occurs after settlement, avoiding a transient duplicate
optimistic application on the newly read baseline.
Startup reconciles known committed receipts before refreshing demand snapshots,
which may already contain the remote edit while its optimistic action is pending.

This is independent of `changes.pull`: receipts identify our own action's effects;
change catch-up must also recover other actors' edits. Foundry still uses watcher
invalidation plus snapshot repair for remote changes. Its old collection path's
edit-history calls were not the new durable change-source implementation.

Reference: Foundry's [Apply Action API](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/actions/apply-action)
documents immediate visibility after completed OSv2 actions. The operation ID is
retained for correlation, not treated as a durable journal cursor.

## Collection demand and query semantics

The TanStack bridge forwards supported filters, numeric/Temporal sorting, lexical
string sorting, and bounded windows to Replica. It derives field types from the
existing ontology IR. There is no additional application schema definition.

Comparison translation preserves TanStack's three-valued null/undefined semantics,
including nested NOT, AND, OR, IN, LIKE, and ILIKE. Field references remain explicit;
source qualification is removed only when the IR declares it.

Unsupported expressions request a safe superset. Supported conjuncts can still
narrow that superset. Locale/custom sorting and residual filters prevent pushing
down LIMIT, since limiting before those operations could omit required rows.
Offset requests fetch a prefix that includes the skipped rows. Cursor requests
include the entire leading-value boundary tie; a locally selected key is not
treated as proof of a remote composite cursor boundary.

Storage ordering now optionally groups null and undefined with explicit first/last
placement, independent of direction. SQL compiles this ordering and continuation
terms into the database. The memory/IndexedDB planner uses exact residual sorting
for that optional grouping rather than prematurely truncating an index scan.

Each active collection demand owns an Effect child scope. Materialization is the
union of its active subsets, so loading or releasing one query cannot overwrite
another query's rows. Cancellation releases the lease and prevents a late subset
read from installing rows. Local-only collection writes continue to refresh their
persisted snapshot immediately, including optimistic:false consumers.

## Watch-only membership repair

An object missing from a filtered snapshot may have changed so that it no longer
matches; it has not necessarily been deleted. For watch-only sources, Replica
checks omitted cached candidates using bounded primary-key batches. It updates
changed objects and removes only identities whose complete lookup proves absence.
Installation and optimistic rebasing then happen in one local transaction. Network
requests happen before that transaction.

## Precise retention and pending work

Active leases persist their actual query. A narrow demand or persisted-only reader
protects its matching rows, not every row of that object type. Unbounded predicates
are checked against each bounded sweep candidate. Bounded windows use storage
queries to mark both confirmed and visible membership; the prefix skipped by an
offset is protected because removing it would change the result.

Pending actions persist point-read identities (including negative reads), observed
query-result keys, query regions, and write targets. This state is updated in the
same transaction as ingest/rebase. Sync does not stop while the outbox is pending,
and unrelated rows remain eligible for eviction. Successful replay replaces the
dependency set; failed replay retains previous dependencies plus its partial
reads. Query regions also protect new matching rows while an action is blocked.
Acknowledging or removing an action releases its durable roots atomically.

Transaction preparation now narrows simple TanStack source predicates and keyed
edits before reading persisted data. Complex joins and derived sources still use
a broader persisted fallback, which also broadens that action's retention needs.
The future [query IR](./query-ir.md) should make those dependencies precise.

Automatic replica GC runs in the owning Effect scope under the same placement
capability as sync. Defaults are a pass every minute, at most 100 candidates per
pass, and a 24-hour age threshold. The age threshold ranks disposable cache data;
it does not decide replication freshness. `gc: false` disables scheduling, and
manual `startSync: false` instances remain manually maintained. Explicit pins,
live subset leases, and pending-operation roots override age. This policy touches
replica base rows, never authoritative backend or local-only tables.

The sweep timestamp, pending sequence, primary keys, and dependency identities have
indexes. Unbounded regions are not expanded into whole-type in-memory mark sets.

## Remaining work

These rules are intentionally simple overlap detection. They do not implement
arbitrary predicate containment, durable Foundry edits cursors, filtered journal
subscriptions, or the shared host RPC/session rollout. Index selection remains an
explicit storage capability; the bridge does not create an index for every incoming
query. Platform integration and ownership consolidation remain described in
[runtime-host.md](./runtime-host.md).
