# Exact-region observation sharing

## First experiment: rejected without a revision fence

The production route profile attributed about 13.5 ms to native DB commit re-entering
the ontology adapter's `loadSubset` for nested includes. One 57-row installation
caused five Notebook snapshots of five rows and four Note snapshots of 51 rows.
The replica already pooled equivalent upstream demand: later repeated correlated
requests added one scoped demand per object type. The initial ordered/limited
Trash demand and the subsequent by-ID region remain distinct.

The remaining duplication is local observation. `persistedCollectionOptions` keeps
one scope, observer and current row map per original `LoadSubsetOptions` object in
`packages/ontology/src/tanstack/collections.ts`. Its cached-availability shortcut
can return readiness immediately, but deliberately retains that request's observer
and scoped acquisition. `replicatedCollectionOptions.observe` calls
`ReplicaService.observeSubset`; `service.ts` compiles each request and
`engine.observeRows` subscribes before reading its initial local snapshot. Native
query commit can acquire another include reentrantly before the first observer's
publication has returned.

Sharing one active observer and row map for an identical lowered subset could
remove this repeated snapshot/decoding work. It is not safe from subset identity
alone. The adapter merges logical demands in insertion order, so X, Y, X makes
the last X the winner for overlapping rows. If the first X observer has not yet
processed a commit that Y has seen, aliasing the late X to that older map can
overwrite Y with an older value. The previous implementation starts a fresh X
observation instead. Membership changes matter too: a newly observed row held
only by Y can disappear after Y unloads if the late X reused an older membership
map. Equal current values do not establish complete, current membership.

The replica has the relevant revision internally: `VisibleCommit` and the initial
snapshot in `packages/ontology-replica/src/visible.ts` carry visible revisions.
Its public `ReplicaRowsBatch` exposes only reset, rows and removed keys. Independently
scheduled observation batches therefore provide no freshness fence for admitting
a new logical caller into an existing observer. Content comparisons, key-set
heuristics and elapsed-time gates would add work without proving that fence.

No grouping change was retained. `collections.ts` was restored byte-for-byte to
the pre-experiment source; no tests or dependency patches changed. The draft is
archived outside the workspace at `/tmp/party-adapter-groups-abandoned.ts` only.

A future design should make revision-aware observation ownership explicit at the
native replica boundary, before pooling in the adapter. It must preserve original
caller signals/unload identities, positive point readiness versus complete absence,
logical overlap precedence, errors and last-lease cleanup. Regression cases should
include a duplicate acquired during a held first commit; X/Y/X with delayed updates,
insertions and removals; abort of the first caller while a sibling remains; and
old-scope batches/errors arriving after final release and reacquisition. Generic
persisted callbacks may intentionally depend on their original subscription or
signal and must retain their independent behavior.

## Revision-fenced implementation (2026-11-09)

Native observation batches now report the global **local visible revision** of
their rows and membership. Empty batches advance this revision too; it is separate
from upstream coverage. The infrastructure-only `readVisibleRevision(replica)`
capability reads that fence from the replica's own Tables service. Custom replica
implementations without a native kernel retain independent observations.

The adapter shares an observer and its existing row map only for an identical
lowered ObjectSubset. Every logical caller still acquires its own scoped demand.
After that caller begins, it reads revision R and cannot contribute the shared
map or report readiness until the observer has reached at least R. This prevents
the late-X stale-value and membership race described above. It adds no second row
cache or polling timer.

Group registration is atomic; observer startup transfers to the group scope
before the first caller can cancel it. Rows and revision advance before invoking
DB publication, which may acquire another include reentrantly. Each publication
captures the members it can settle before awaiting acceptance, so it cannot settle
a newly joined member whose own publication is still queued. Last-member release
closes the observer. Generic persisted collection callbacks remain unshared.

Validation: 319 replica tests and 181 ontology tests passed, including seven native
revision tests and ten sharing/lifecycle regressions. These cover stale X/Y/X
values and membership, empty results, synchronous positive point reads, held
commits, independent cancellation, closed/reacquired groups, and concurrent startup
under Effect's low cooperative-yield budget. Notes' build also passed. No dependency
patch was added.

The fence audit also found that the visible transaction wrapper inherited raw
`insert` while wrapping `put`, `putMany`, `delete`, and `clear`. Current production
replica paths did not use direct insert, but the generic operation now receives
the same tracking. Successful inserts advance the revision and emit a row change;
duplicate-key and unique-index rejections leave both unchanged.

### Measured effect and limits

Chrome 156, production preview over the local HTTP/2 proxy, devtools closed,
offline downloads enabled, disposable profiles, no concurrent builds/tests:

| Measurement                                  |   Before |   With sharing |
| -------------------------------------------- | -------: | -------------: |
| Initial Notebook snapshots                   |        5 |              2 |
| Initial Note snapshots                       |        4 |              2 |
| Initial local publication, retained worker   |  27.8 ms |   25.0–25.3 ms |
| Initial local publication, restarted worker  |  29.2 ms |        24.9 ms |
| Fresh tab, retained worker: rows in DOM      | 180.6 ms | 179.5–183.8 ms |
| Fresh tab, retained worker: paint checkpoint | 248.6 ms | 256.0–259.3 ms |
| Restarted worker: rows in DOM                | 300.2 ms |       300.3 ms |
| Restarted worker: paint checkpoint           | 360.1 ms |       354.5 ms |

These are individual runs, not a statistical distribution. Sharing reduces the
repeated work, but **does not demonstrate a material initial-page speedup**. The
100 ms target remains unmet. Artifacts are `/tmp/party-observation-{warm,warm-repeat,cold}-ui.json`
and matching `-traces.json`; the prior pair is `/tmp/party-scalar-final-{warm,cold}-ui.json`.

A separate profiled run attributes its 211.5–241.1 ms publication interval to
roughly 10 ms of correlated include demand, 8.15 ms of other native query graph
work, and 3.32 ms of collection commits. Its 244.7–308.4 ms interval contains about
39.5 ms of React work and 12.64 ms in sticky-header geometry measurement/observer
setup. The latter can force layout that the browser may otherwise perform later;
removing the synchronous measurement alone previously failed to improve paint.
The final empty publication overlaps React effects and must not be reported as
29 ms of database computation. Neither interval shows repeated query compilation.
See `/tmp/party-observation-mapped-cpu.json`; keep these profiled timings separate
from the clean runs above.

Production browser checks passed over HTTP/2: initial load, note deep-link reload,
Trash pagination 50→100, and return to Notes. The plain HTTP/1 preview stalled on
note navigation with its route JavaScript and favicon still pending and no page
error. This is consistent with the previously observed streaming connection-slot
limit; it is separate from the HTTP/2 performance measurements. Diagnostic output:
`/tmp/party-http1-probe.json`.
