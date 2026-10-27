**Protocol-child GC: concrete cases**

Design examples for the follow-up implementation. This checkpoint moves platform
composition and collection integration; it does not remove the protocol GC/blob
guard. GC can be completed alongside incremental delivery, and the coherent
installer can also support it while snapshots remain the transport.

## 1. Release an issue query

A tab has a selected Issues query containing Issue 42. Its local tables contain
confirmed `parent-base:Issue[42] = Open`, inherited
`parent-overlay:Issue[42] = Completed`, and materialized `base:Issue[42] = Completed`.
The page navigates away and releases its last query root.

Today the next selected snapshot replaces these records with the new selection.
The ordinary age-based sweeper is not wired into this import path. If we merely
enabled the old sweeper, it would either find no retention candidate, or delete
only the materialized base copy, leaving the imported copies and head claims.
Later recomposition could restore the evicted row.

The follow-up must remove an unneeded imported record and its materialization,
update blob roots/coverage, and change selection progress coherently. It must
not delete Issue 42 from the parent/authoritative database. Whether inactive
confirmed rows are kept for a grace period is a cache policy, not a sync delete.

## 2. A pending rename still needs Issue 42

The list has unmounted, but the tab has an unaccepted Rename action whose local
transaction read Issue 42. A concurrent upstream update can require replaying
that action. Sweeping the issue just because no React component queries it could
make replay fail or change its result.

Existing action row/query dependencies remain roots. Protect those exact rows
and query dependencies until responsibility is transferred or the action is
settled/discarded. Do not protect the whole Issue type or pause all GC whenever
any outbox entry exists. Source acquisition and sweep use the same transactions
for their root records so a root cannot appear halfway through deletion.

## 3. A patch assumes a row is resident

The child acknowledges stream position 20 containing Issue 42. It evicts the row
without changing its selection or installed position. At position 21 the parent
changes only Issue 77. A correct diff does not resend unchanged Issue 42, leaving
the child permanently missing data it still claims to have.

Active imported membership is protected. To release it, change selection with a
new generation; to drop/rebuild its state, request a replacement snapshot/new
epoch. Never acknowledge a baseline that no longer matches the stored mirror.
The same issue exists with today's equal-revision snapshot short-circuit: local
eviction must invalidate the corresponding installation/coverage claims.

## 4. Created attachment, tab-to-worker handoff, then restart

A user adds `photo.png` and submits Create Issue. The child has staged bytes and
a local outbox root. Its worker accepts the action but the upstream has not yet
confirmed it. A premature cleanup that removes the child's root before the
worker has durable bytes could lose the only upload copy.

In the intended normal-child attachment path, the worker must have staged the
needed bytes before advertising durable action acceptance. Store returned
receipt/mapping evidence before changing aliases. The child's handoff, mapping
and root updates are transactional. Pending/forwarded actions retain their
required staging through recovery. A reset discards imported cache roots, not
these action-owned bytes. Cross-process IO still uses intents/retry identity;
there is no shared database transaction between tab and worker.

At this checkpoint the tab delegates creation to the worker, so its bytes are
already worker-owned. That is why we have not yet exercised this independent
child staging case. It is a concrete acceptance test for removing the guard.

## 5. A cached attachment can lose bytes without losing its row

Issue 42 references a remote 50 MB attachment. Its identity and source locator
remain available, but the child need not keep 50 MB in memory forever. An
ordinary row reference retains identity, not necessarily cached bytes. An offline
pin or pending upload can retain bytes; a scoped reader pins them until EOF or
cancellation. Byte eviction updates metadata transactionally and deletes external
bytes through generation-fenced intents.

Each replica should ultimately use the same BlobStorage model, with memory or
durable bytes and its parent as the remote attachment provider. Memory does not
mean eager download. A configurable cache policy can avoid long-lived duplicate
bytes in tabs while preserving normal replica semantics.

## Suggested decisions

- Keep exact active-demand/action/pin roots, not whole-type protection.
- Preserve current age-based policy for reusable confirmed cache; do not invent a
  new protocol-specific retention policy. Mirror membership release may drop
  records immediately as snapshots do today.
- Reuse BlobStorage/intent machinery at each replica; treat current tab delegation
  as a temporary gap. Do not add a second lightweight tab-only blob manager.
- Reset selection/stream evidence when dropping an installed mirror. Preserve
  outbox/forwarded state and required staged bytes.
- Implement these invariants in the common installer, with snapshot and patch
  tests, before removing either protocol guard. No IVM requirement.
