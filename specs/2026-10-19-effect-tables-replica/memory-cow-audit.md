# Memory storage COW audit

The memory driver now uses structurally shared roots instead of cloning a whole row Map and sorted Entry array at the first edit in every transaction. Rows use Effect HashMap. Primary-key order and scalar index order use a private 32-way persistent B+tree. Rank metadata makes bounded index windows and counts independent of a full-index scan. A reverse map from row key to encoded values makes index deletion proportional to that row's memberships rather than the entire index.

A reverse membership is one encoded string for the common scalar case, promoted to an Effect HashSet at the second distinct value. Large multi-entry fields retain persistent set updates; duplicate values remain one index membership. Definition metadata retains its existing insertion order. Existing semaphores, validation/codecs, commit/rollback, read-only and closed-transaction checks are preserved. SQL and IndexedDB drivers are unchanged by this memory representation.

Private Rows/Index holders use `Equal.byReferenceUnsafe` on freshly allocated internal objects. They are never caller values. Effect 4 otherwise structurally hashes the nested trees and maps whenever an outer HashMap compares old and new values. The first candidate spent 11 s of its 100k-row CPU profile in Hash.hash; this correction removed that unnecessary traversal. No transient Btree mutation, additional dependency, application cache, or new public setting was added.

## Controlled measurements before folded-index elision

Node 24.14.0; separate processes; 100,000 synthetic rows, two ordinary scalar indexes; one bulk population, 21 edits to an existing middle row, and 11 repetitions of each 51-row read (first edit/read excluded from medians). Forced GC occurs outside timed work. Retained heap deltas exclude the input fixture and loaded modules. These are isolated storage measurements, not whole-app timings.

| Measurement           | Prior Map/array driver | Initial compact COW candidate |
| --------------------- | ---------------------: | ----------------------------: |
| Populate 100k         |               4039.7ms |                      2743.0ms |
| One-row edit median   |                38.77ms |                       0.137ms |
| Indexed range window  |                0.646ms |                       0.652ms |
| Equality-index window |                0.422ms |                       0.424ms |
| Primary-key window    |                7.531ms |                       0.054ms |
| Retained heap delta   |                 81.4MB |                       154.0MB |

The remaining heap increase is material: persistent row/index nodes and the reverse membership index use more memory than the old flat arrays. The current implementation improves edit/load cost while retaining this measured memory tradeoff. The discarded fully structural candidate loaded in 17.86 s and retained 326 MB; private identity holders reduced that to 2.94 s / 224 MB, and compact singleton membership reduced it to 2.74 s / 154 MB. Do not describe the discarded version as the landed behavior.

The checked-in implementation was repeated with two GCs at each heap checkpoint: population 2722.4 ms, edit median 0.142 ms, indexed window 0.720 ms, equality window 0.438 ms, primary-key window 0.057 ms, and retained delta 153.9 MB. The heap increase persists after additional GC. The small read differences are reported directly; these runs do not establish a statistical distribution.

## 2026-11-09: per-table index holder follow-up

An anchored Notes import profile found that the outer table-to-indexes HashMap still compared a newly updated inner index-name HashMap structurally. The existing private Index holders prevented traversal of their Btrees, but hashing the inner HashMap remained unnecessary. Memory now wraps that map in a fresh private `TableIndexes` holder, using the same identity rule as Rows/Index. User values and shared Effect maps are not marked by reference.

This incremental pair compares the immediately preceding COW driver with that holder change, using the same generic Tables/codec implementation and the checked-in benchmark's two-GC checkpoints. It predates the separate sparse folded-index change; it must not replace the original Map/array comparison above.

| Measurement         | Prior COW driver | With TableIndexes holder |
| ------------------- | ---------------: | -----------------------: |
| Populate 100k       |         2724.0ms |                 2410.2ms |
| One-row edit median |          0.165ms |                  0.139ms |
| Retained heap delta |          153.9MB |                  148.0MB |

Population improved by 11.5% in this pair; indexed-range and primary-key read medians remained approximately unchanged. The retained-memory tradeoff versus the original flat driver remains material. These are single-process samples per arm, not a measured distribution or a whole-app speedup. Storage checks/build and all 126 tests passed, including the retained-root, transaction and independent planner oracles. Artifacts: `/tmp/party-memory-holder-{before,after}-results.json`; captured prior factory: `/tmp/party-memory-holder-before.mjs`.

## Final driver pair after portable folded-index elision

Both drivers were rerun against the **same current generic Tables implementation** after it stopped creating case-insensitive index entries for non-string portable values. This keeps the representation comparison fair; it does not attribute the common reduction in physical index writes to COW.

| Measurement           | Prior Map/array driver | Current COW driver |
| --------------------- | ---------------------: | -----------------: |
| Populate 100k         |               3152.8ms |           1765.4ms |
| One-row edit median   |               30.623ms |            0.119ms |
| Indexed range window  |                0.560ms |            0.578ms |
| Equality-index window |                0.426ms |            0.443ms |
| Primary-key window    |                6.633ms |            0.054ms |
| Retained heap delta   |                 61.5MB |            100.7MB |

Node 24.14.0, separate sequential processes, two GCs per heap checkpoint, no concurrent tests/builds/browser probes. Artifacts: `/tmp/party-memory-final-{baseline,cow}.json`. This pair still shows about 64% more retained memory than the flat representation, despite the lower absolute heap footprint. Indexed query timings are approximately unchanged; these single-process samples are not a distribution. Full Notes timings must be measured separately.

Portable folded-index elision is covered by physical write-count and independent mixed-value query tests. Native SQL projections retain non-string sentinels, avoiding SQL NULL changes to `NOT ILIKE`. The final shared-storage/SQL graph passed 130 storage tests and 27 SQL tests, including actual PostgreSQL, SQLite and PGlite regressions.

## Reproduce

Build `@party-stack/ontology-storage`, then run:

```sh
node --expose-gc packages/ontology-storage/bench/memory-cow.mjs
```

`PARTY_MEMORY_ROWS` changes the synthetic size (minimum 10,000). For a controlled comparison, preserve the prior driver's compiled factory before rebuilding and pass its absolute path in `PARTY_MEMORY_BASELINE`. That factory must resolve the same shared Tables/codec modules. The captured prior factory is `/tmp/party-memory-cow/baseline.mjs`. The checked-in benchmark performs two GCs at each heap checkpoint to reduce weak-table cleanup noise, as used in the final comparison. The earlier compact-candidate table used one GC; it is retained as historical evidence, not pooled with the final comparison.

## Correctness evidence

- The 100k-entry retained-root test verifies that an edit allocates exactly one new node per tree level and shares every untouched subtree by identity.
- Split/borrow/merge/root-collapse cases retain prior root values.
- Effect Arbitrary compares persistent edits, rank bounds, ascending/descending slices, and transactional row/index actions with independent Map+sort oracles.
- Transaction tests cover rollback after index merges, clear rollback, caught unique errors, closed handles and interruption after writes.
- Multi-entry tests cover 2048 distinct values, duplicates, replacement, neighbor preservation, deletion and clear.
