**Replica state and GC · October 27, 2026**

The row storage simplification, protocol-child row GC and independent local
attachment storage described below are implemented. Incremental selected-state
delivery remains future work.

## Start with three things

A replica has:

- **Base:** the portion of its parent's published state that it needs locally.
  The parent may be authoritative or may itself have pending writes.
- **Outbox:** this replica's own actions still awaiting an outcome.
- **Overlay:** the changes predicted from those actions that are not already
  represented in base.

The parent's pending changes are part of what this replica receives as base.
They are not this replica's outbox. We can retain selected parent action records
for action completion or an inspector without importing every parent action.
Base may preserve parent confirmed rows and published predictions separately
when a confirmed-only read needs that distinction. Those are data inside base,
not another independently managed local replica.

The implementation stores confirmed rows and sparse inherited overrides inside
base. Reads compose them directly. There is no additional parent-visible row table.
The child's own sparse overlay is recomputed from its outbox. An outbox entry gets
an internal inclusion marker once its action appears in received parent state;
that marker prevents a second prediction or submission. There is no separate
forwarded-action table.

## One rule for cached data

**Keep the base data needed by active queries, pending actions, and explicit
pins. Other cached base data can be removed under the cache's retention policy.**

Forgetting local cached data does not delete an object upstream. The overlay is
recomputed from retained base and the local outbox. GC does not silently discard
unresolved actions. Authoritative application rows are durable application data,
not an age-evicted replica cache. Orphaned authoritative attachments can still
have their own configured cleanup policy.

The same rule applies to a replica backed by IndexedDB, memory, or SQL, regardless
of whether the parent is an adapter or our protocol. The implementation must
update base, derived data, coverage and blob references in the same transaction.

## 1. Stop requesting Issue 42

A React component has a live query showing Issue 42. You navigate to another
project and that component unmounts. Its query stops requesting Issue 42. This
is what the earlier phrase "leave the issue list" meant; the engine sees query
acquisition/release, not page names.

If another component still requests Issue 42, keep it. If a pending action needs
it, keep it. If neither does and it is not pinned, its cached base data is eligible
for removal under the retention policy. Remove the associated derived data and
references together. Do not keep the entire Issue type just because another issue
is being displayed.

The current protocol asks the parent for the data needed by all active queries
and action dependencies. The parent replies with that requested state. Today
that reply replaces the previously imported state; if Issue 42 is no longer
requested, the next reply can omit it and its imported copy is removed. This
already prunes data. The same bounded age-based collector also handles protocol
base rows: it removes confirmed data, its inherited override, retention metadata,
and affected coverage in one transaction. A later local rebase cannot recreate it.
The imported head keeps a SHA-256 digest and a residency flag, so an unchanged
parent revision can safely refill evicted data without disabling revision checks.

## 2. Stop displaying an issue while its rename is pending

The tab has a Rename Issue 42 action in its own outbox. Even if no component
shows the issue anymore, the action's transaction read it and may need it again
when replaying over updated parent data.

That dependency keeps Issue 42's required base data alive. It does not keep every
issue alive or pause all GC. Once the action settles, release dependencies that
are no longer needed. Accepted actions can retain status/receipt tracking until
the final outcome without retaining an unnecessary duplicate prediction.

## 3. Parent acceptance must not apply the action twice

The parent shows a counter at 1. The child predicts Increment and shows 2.
The parent then publishes a new state that already includes that same Increment.

In one transaction, the child installs that base and records that the action is
already included there. Its overlay stops applying the extra increment. It
continues to show 2. A later authoritative result settles the action.

If upstream instead rejects the parent's increment, the parent sends corrected
data. The child updates base and replays its own remaining actions normally.
There is no separate child rollback engine for inherited predictions.

Acceptance and inclusion are different: a reply saying "accepted" does not prove
that the child's installed base already contains the prediction. Keep that small
piece of evidence with the local action. The conceptual model does not require
another outbox or another row store for this bookkeeping.

## 4. Do not claim to have data that was evicted

The parent sends Issue 42 and the child acknowledges receiving it. Later the
parent changes only Issue 77. Incremental delivery correctly sends only Issue 77.
If the child quietly deleted Issue 42 while still requesting it, its data would
now be incomplete.

The active query protects Issue 42. To stop keeping it, release that demand.
If the child deliberately drops its cached base, it must also drop the claim
that it has a complete copy and fetch that data again. This is ordinary cache
coverage/stream bookkeeping, not a second GC policy.

## 5. Attachment bytes can have a different lifetime

An issue references a 50 MB video. Retaining the issue and attachment handle does
not require keeping all 50 MB of bytes in tab memory. An unpinned byte cache can
be evicted and read again from the parent. A currently running reader or an
explicit offline pin protects the bytes it needs.

A newly created photo is different: if a pending action needs its only staged
copy, keep those bytes. Before a persistent parent promises durable acceptance,
it must have the required bytes or a durable means to obtain them. Record
handoff/mapping evidence before releasing the child's last required copy.

Use the same BlobStorage metadata/reference/intent machinery at every replica,
with memory or durable bytes. Reads can stream through from the parent; whether
to retain a local copy is cache policy. Future range caching can retain only
requested video intervals without changing the base/outbox/overlay model.

## What qualifies the three retention roots?

- Action dependencies include transaction reads/writes and query results, not just
  IDs in action parameters. They survive parent inclusion until final reconciliation.
- An offset/limit query needs its influential prefix. Marking considers confirmed,
  parent-published and locally visible rows, so a prediction cannot hide needed base.
- Eviction must clear the data and its completeness/residency claims together.
  Actual upstream deletion still wins over a local pin.
- Running byte readers temporarily pin bytes through completion or cancellation.
  Remote cached bytes and the sole staged copy of a pending upload have different
  retention needs, both handled by BlobStorage roots.

Selected parent action records and source/view positions are base/protocol
bookkeeping. Terminal results, client sessions and delivery records have their
own bounded retention; unresolved own actions remain in the outbox.

Tabs use normal local BlobStorage with the parent as a remote provider. Memory
tabs and persistent children collect their own bytes independently. Reads stream
through while filling the local cache. New action attachments transfer before
parent acceptance; required bytes and outbox roots are checked/installed in one
parent transaction. Duplicate accepted submissions need no second transfer.
Receipts are persisted before local alias reconciliation, so a failed mapping can
recover after restart without resubmitting. There is no protocol-child GC/blob guard.
