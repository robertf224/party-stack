# Upstream persistence contract cases

Source: [TanStack/db SQLite adapter contract](https://github.com/TanStack/db/blob/2c98b4992c412820f8476325ee6941db5ca9ac0f/packages/db-sqlite-persistence-core/tests/sqlite-core-adapter-oracle.test.ts).
Pinned commit: `2c98b4992c412820f8476325ee6941db5ca9ac0f` (2026-10-07 audit).

These cases run through one harness against our IndexedDB adapter and the installed upstream SQLite adapter (core 0.4.5). They also run against native browser IndexedDB. Assertions and transaction fixtures are retained for stream-position idempotency, atomic rollback, metadata, truncate, replay thresholds, metadata-only replay, cursor ties, custom collation, distinct numeric/string keys, boolean/operator fallback, and typed bigint/Date predicates.

Adaptations: replace SQLite driver/table introspection with public stream-position, replay, and metadata assertions; supply a backend-specific serialization failure (the original invalid Date for SQLite, an unsupported function for IndexedDB, which natively accepts invalid Date values); inject adapter creation/cleanup; remove Node imports; require the replay extension in the harness type; acquire typed indexes for the bigint/Date fixture, since unpaginated subset reads may return candidate supersets. SQL compilation, physical table naming, SQLite scheduling/driver admission, binding caps, and platform-specific SQLite bridges are not IndexedDB contracts. Other existing IndexedDB tests cover idempotency, schema policies, bounded histories, resume snapshots, query planning, and index lifecycle.

No upstream persistence-specific benchmark suite was found at this commit. Upstream's incremental-update benchmark targets in-memory collections, joins, and materialization. Our browser benchmarks instead measure actual IndexedDB reads and incremental writes on a fixed 10,000-row dataset; they are not presented as a port of that benchmark or a cross-engine comparison.

## License

MIT License

Copyright (c) 2025 Kyle Mathews

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
