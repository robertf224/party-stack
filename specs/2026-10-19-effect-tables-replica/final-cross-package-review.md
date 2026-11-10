# Final cross-package pass — November 3

This follows the functional subsystem reviews. It checks current public boundaries,
retained state and startup behavior; it is not a claim of exhaustive fault coverage.

## Boundaries and retained state

Backend implements data/action capabilities; replica owns local state and sync;
server exposes those capabilities over transports; ontology provides typed SDK and
TanStack/Promise authoring. The lower runtime, Connect, backend, replica and server
packages have no imports of the ontology SDK or TanStack collections.

- Runtime partition acquisition is shared through LayerMap. Connect retains owned
  sessions and reactive connection metadata, with scoped listeners/locks. Its rows
  are not a separate UI collection.
- Native installation sharing and account-to-partition inventory remain separate
  from the SDK's per-view memoization. Their caches own different lifetimes, rather
  than duplicate data/sync engines. The worker endpoint cache retains transfer
  handlers during overlapping RPCs, preserving Create/Chunk ownership.
- Storage indexes and query-local planning/correlation maps remain implementation
  details. No new cross-request query-result cache was introduced.
- Replica demand has reference counts, idle retention/capacity and explicit pin
  lifetimes. Object/attachment GC and max/target cache budgets do not evict required
  data or cap arbitrary finite-query/authorization working sets.
- Delivery comparison state is durable and expires through owner maintenance.
  Live acknowledgment queues are scope-owned. Attachment transfer queues have
  ownership, byte/concurrency/time limits and cancellation.
- SDK collection rows/fingerprints belong to collection lifetime. They are a
  TanStack materialization, not another durable replica. A broad active UI query
  can still consume significant memory beyond native object-cache targets.

No further public manager, storage-notification service, schema route registry or
general cache abstraction is needed for this pass. Full-query demand/IVM, composition,
SSR/fragments and schema migration remain the explicitly scoped future work.

One SDK naming mismatch is removed: the standalone constructor's ConnectionMonitor
option is `authentication`, matching Replica. Protocol constructors still use
`connection` for the actual acquired transport; these are different requirements.

## Startup changes

Issue-tracker previously serialized its two installation startups, and then opened
Foundry profiles before beginning SQLite profile opens. Independent acquisition now
runs in parallel. The app's devtools shell stays lightweight on the startup path.

The devtools package previously imported every inspector through its entry point,
including schema layout, table rendering and icon tooling. Chrome, types and plugin
construction are now separate. Inspectors load through React.lazy only when the
plugin opens; direct panel consumers use the same lazy wrapper. Public exports retain
their names. `preloadOntologyDevtools()` also lets an app warm code for offline
inspection after displaying its first data, without mounting inspectors or creating
demand. Issue-tracker does this. An error boundary isolates optional inspector load
failures from the application. Offline tests warm code while online before asserting
offline inspector behavior; the framework does not supply an offline app shell.
A separate browser regression aborts the inspector module download and verifies
that its error boundary leaves the issue tracker and create-issue dialog usable.

The TanStack collection bridge previously awaited upstream readiness before starting
its local row observer. It now starts both in the same acquisition scope. Existing
cached rows may publish while refresh is pending, but the load promise still waits
for remote readiness and initial observation. Failure/cancellation closes the same
child scope. A regression holds remote readiness and checks visible cache data plus
the still-pending completion promise; it failed before the change.

The final worker browser pass also exposed a short offline/reconnect race. Reading
`connectivity.online` could return false without recording false in its reactive
state. If reconnect overtook the asynchronous native-event consumer, it observed
true -> true and emitted no wakeup for the paused outbox. The read now records an
observed offline state before returning, preserving the subsequent stabilized online
notification. No outbox poll/timer was added. A TestClock regression performs the
offline read and reconnect without yielding to the event consumer; it failed before
the fix and passes afterward, alongside the other platform connectivity tests.

The reconnect audit found a separate committed-delivery bug. `openParentDelivery`
rewrote retained frame metadata with the current local selection generation. After
switching away and back to the same selection, a replayed stream/sequence therefore
had a different fingerprint and stopped replication with Conflict. Wire frames now
remain unchanged. A private Effect reference carries the local generation only for
the transactional stale-selection fence. The regression verifies exact retained
frame identity, harmless duplicate delivery, and rejection of a superseded frame.
It failed before the fix. The full native suite and two consecutive worker browser
runs passed after it.

## Measurements

Isolated Chromium, local issue-tracker dev server, SQLite demo account; three refreshes
per run with no fixed sleep in the measurement. Timed from navigation start to the
first issue status control being visible. These are development samples, not a
Foundry benchmark or a production performance guarantee.

- Original: 4,376 / 4,116 / 4,796 ms. A second instrumented baseline measured
  5,375 / 5,559 / 4,621 ms with 2,635 resource entries.
- An intermediate implementation that lazily loaded the whole devtools component
  immediately alongside the list regressed to 7,476 / 7,569 / 8,798 ms. It did not
  reduce inspector imports and was replaced by the package split above.
- With inspector-on-open loading: 3,676 / 3,255 / 3,137 ms with 748 resource entries.
- Final offline-safe shell and post-data code warming: 4,189 / 3,202 / 3,405 ms.
  Median 3,405 ms versus 4,376 ms in the original run. Resource samples were
  749 / 867 / 2,090 because optional warmup starts after data appears, rather than
  blocking its display. These counts are sampled resource entries, not a production
  bundle-size or total-download guarantee. Workstation/dev-server variance applies.

The user's observed slow profile was Foundry. Its authenticated browser surface
was unavailable to the automation binding; no real-account Foundry latency is
claimed. Its shared startup and cached-row paths receive these changes. Provider
round trips, cold worker restoration and large active queries remain relevant.

## Setup and branding

Public docs now follow tasks: web setup, SQLite server, Foundry accounts, queries
and actions, attachments, encrypted values, offline data, and authorization.
The former runtime/storage/replica essays are consolidated; their URLs redirect.
Authorization includes project administration, descendant grants, conditional
properties, and a token-scoped Post Approval projection. Architecture has an
interactive issue-update model, including durable intermediate acceptance,
rejection, and offline waiting, rather than an implementation proposal.

Website adopts Streamline's root-level sticky header and transparent borderless
sidebar. Mobile search/dialogs layer above the site header. The empty footer and
theme selector are removed. The whole site follows the system color preference.
The home page is one hero, with an optional VGPU animation that releases its GPU,
listeners and observers on teardown, respects reduced motion and caps in-flight
render work. Static artwork remains when WebGPU is unavailable. Headless Chromium
on this workstation does not capture WebGPU canvas presentation correctly;
GPU pixel readback and a headed Chromium visual check verified the shader.

`@party-stack/design-system/brand` and `tokens.css` share existing devtools artwork
and light/dark colors with the website; this is not a new component framework.
New logo boards are review artifacts only and do not replace the current mark.

Writing complete examples exposed three remaining ergonomics issues:

- Browser installation setup still needs explicit worker, Connect/configuration,
  runtime Layer and owning Scope code. The single-HTTP-client path is much smaller.
- `createConnectedLiveOntology` describes a dynamic endpoint but does not expose the
  same typed ontology generic as installation.openOntology. Generated types are
  useful, but this path still lacks a straightforward typed view constructor.
- Persistent query pinning is an owner operation. In the SharedWorker placement,
  a tab's native replica is memory-only; setting its pin does not save a pin on the
  worker. A future account/client-level owner operation should make this available
  without applications adding their own RPC. The docs state this limitation.

All replicas store loaded objects locally; runtime determines memory versus durable
storage. There is no persistObjects flag. Extra broader-subset objects default off.

## Validation

- `vp run ci`: 136/136 tasks passed, including 221 replica tests, 117 SDK tests,
  207 Foundry tests, 44 devtools tests and 15 native web-runtime tests.
- Final SharedWorker/installation browser suite: 5/5 passed (8.29 s). Two earlier
  consecutive runs after the retained-generation fix also passed.
- Final issue-tracker browser suite, with ISSUE_TRACKER_TEST_URL set: 10 passed
  plus the existing expected TanStack disposal-warning failure (110.85 s).
  Includes offline/online optimistic actions, reload, images, account/worker flows,
  inspector failure isolation, tracing and storage inspection.
- Main web client, SQLite owner, installation configuration, worker and browser
  acquisition examples were extracted and type-checked against workspace packages.
- Website final build passed. All ten docs routes returned 200; moved runtime
  URLs redirected. Desktop/mobile navigation, system color changes, no overflow,
  sidebar/search layering, absent footer/theme controls and architecture stepping
  were checked in an isolated browser. GPU shader validation had no diagnostics;
  actual pixel readback, headed rendering, navigation cleanup and reduced motion
  were verified.
- `git diff --check` passed. No dependency patch was introduced. The existing
  workerd disconnect/NDJSON warnings and React/TanStack deferred disposal warning
  remain recorded; a green test result does not imply those warnings are resolved.
