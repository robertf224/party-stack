# SDK, TanStack, diagnostics and setup review — November 3

## Responsibilities

- Backend implements finite data/action capabilities. `makeOntologyBackend` supplies
  Query IR execution through complete normalized subset reads when the provider has
  no native query implementation. Owned queries use one read transaction, including
  the existing batched/grouped correlation path. Caller inputs cannot set trusted
  context. A query result does not establish live demand or IVM state.
- Replica owns local visible/confirmed reads, outbox, action reconciliation,
  attachments, decryption, query-function forwarding, demand, GC and status. The SDK
  has no independent sync/outbox state machine or attachment byte manager.
- Server Query RPC delegates to the acquired backend. Policy projection provides
  the authorized query implementation; cached proxies rebuild query execution over
  their cache reads rather than inheriting the privileged upstream query method.
- LiveOntology adds typing, Promise boundaries, action-result decoding and TanStack
  collections. Its `replica` property is the native service, not another storage owner.

## Collections, state and transactions

`objects` and `cachedObjects` have one ordinary getter per declared object type.
Access constructs and memoizes that collection synchronously in the SDK Scope;
enumerating names does not construct collections. There is no Proxy or collection
family configuration registry. SDK DbClient owns the acquired source collections.

Normal collections translate TanStack load predicates/order/windows into an ontology
subset, acquire shared demand and observe local row batches while initial readiness
is pending. Cached rows can publish early; load completion still waits for readiness.
`cachedObjects` uses `localOnly`: retain and observe installed visible rows without
requesting new parent/provider data. Both include the replica's composed optimistic
state. The platform runtime, not this option, selects persistence.

Native reads supply attachment/encrypted-property sources before collection writes.
Query IR evaluation preserves sources through aliases in the shared query engine.
The SDK has no row-decoration hook. Arbitrary collection `map` and unimplemented
`utils.refresh` options are removed; application projections belong in queries.

The bridge tracks active subset scopes, their selected rows and installed value
fingerprints. It applies inserts/updates/removals as TanStack sync batches and lets
TanStack maintain derived queries. Aborting or unloading a subset closes its scope;
the native shared-demand cache handles reference counts and optional idle retention.
Read cancellation does not own an accepted action's execution lifetime.

Two lifetime/selection regressions were added:

1. A local inspection consumer can outlive its replica. The same retention lease is
   linked to both scopes; either closure releases it once, before owner storage closes.
2. Local read roots must not change a protocol child's upstream selection. Previously
   the speculative path included reader roots as remote interest. Only remote-demand
   roots participate now; pins and action dependencies still add their own selections.
   Tests requesting upstream data now use actual demand rather than this old side effect.

## Actions, results and errors

SDK actions delegate validation, draft validation, default resolution and execution
to Replica. Their Promise resolves after authoritative confirmation and local
reconciliation; optimistic visibility remains independent. Declared action results
are decoded from the receipt's JSON value. Query functions already return logical
ontology values, including Temporal instances, and are forwarded without another
JSON decode. Provider and owned boundaries keep their validation responsibilities.

Outbox controls delegate to the owning native outbox. Editing preserves the action's
replay inputs and logical Temporal values; missing entries throw a typed NotFound.
The previous structuredClone dropped non-structured-cloneable logical values.

SDK startup is awaited by construction, so the always-resolved ready Promise and
waitForLiveOntologyReady helper are removed. SDK destroy is removed: cleanup closes
a view; installation forget coordinates account-to-partition associations and shared
ownership; explicit native Runtime destruction administers standalone partitions.

Metadata pull uses multi-root backend queries followed by transitive value-type
queries. The Promise wrapper accepts an acquired metadata backend. It does not
construct a synthetic backend over UI collections or require a replica.

## Diagnostics and setup

- Trace recording remains independently opt-in. The standard installation worker
  provides a live feed, not a completed server history. Each inspecting tab keeps
  at most 500 records; each record retains at most 100 diagnostic events. Export to
  an application-provided Effect tracer remains independent.
- Traces RPC is explicitly authorized and absent from public policy projections.
  Its callback queue is sliding/bounded and releases its listener with the RPC Scope.
  Clear is local to a tab. Attribute allowlisting and bounded error messages exclude
  arbitrary error payloads and stacks; diagnostics remain privileged data.
- Status subscriptions, storage inspection, row collections and byte-source reads
  retain their native lifetimes. Storage usage is measured on reads; no per-write
  per-type usage counters were added. A displayed cache budget is not a whole-process
  memory limit or a physical database quota.
- Setup uses a single persistent SharedWorker owner and ordinary memory tab replicas,
  with normal tab byte storage. There is no page-side persistent fallback or shared
  raw-table access. SDK cleanup and account forget are documented separately.

## Verification and deferred boundaries

Native tests cover query context/input isolation, provider-native execution,
transactional owned hierarchical queries, source provenance, broader/incomplete
provider results, RPC/policy/cache composition, metadata pull and acquisition cleanup.
Collection tests cover lazy construction, local-only cache inspection, shared native
rows, cleanup, abort propagation and initial-observation races. Retention tests force
consumer/owner closure ordering; delivery tests distinguish local and remote interest.

Verification completed with all 133 workspace CI tasks successful, all 5 web-runtime
browser tests passing, and issue-tracker's 9 browser tests passing alongside its one
expected failure. The existing React/TanStack delayed derived-query disposal warning
remains deferred as agreed; no dependency patch or new React lifecycle hook is added. SSR
hydration and Relay-style fragments remain separate design work. Full-query demand,
server IVM, general ontology composition and untrusted speculative-state projection
are not introduced by finite backend queries.
