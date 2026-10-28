# Gateway migration gates and deferred protocol work

## Agreed v0 sequence — October 27

Gateway parity is the final implementation phase of v0. Before it, finish native
adapter cleanup/operation naming, byte-stream attachment transfers with bounds and the remaining
provider/example recovery and lifecycle acceptance work. Do not prioritize Salesforce
CDC or add subscribeSubset before closing those gates.

Pull hierarchical Query IR and authenticated context binding into that final Gateway
phase. Express relationships, nested queries and correlations in the shared query
model; do not introduce a separate exists-first public authorization API or another
policy-only expression language. Existence tests may be an execution lowering detail.
Query construction does not itself implement authorization: the executor must apply
policy to referenced objects/dependencies before ordering and pagination.

The final acceptance checklist is projected dynamic Describe/context discovery;
hierarchical/context-path read policies and query restrictions; object-reference
parameter authorization through those same views; fixed/generated parameter handling;
authorized prefill and query functions; source-row/property attachment reads;
principal/form/revision-bound uploads and request limits; and real form submission,
structured validation, unknown-outcome and context-change isolation flows.

Retire the deprecated HTTP transport after those workflows run on native operations.
Its remaining presence does not justify retaining legacy adapter validation,
attachment or cleanup hooks. General untrusted replica-state access and live
hierarchical query subscriptions remain separate future work.

Inspected October 26, 2026 against the local Streamline checkout. No gateway files
were changed. Relevant sources are streamline-gateway/src/logic/liveOntologyDataLoaders/
remoteFormOntologyServer.ts and createSecuredFormRemoteOntologyServer.ts,
GatewayLiveOntologyDataLoadersProvider.tsx, and streamline-forms/src/live-ontology/
streamlineRemoteOntologyPolicy.ts.

## Existing workflow

The public form endpoint explicitly allows finite describe, load-subset,
resolve-action-parameters, run-query-function, attachment-metadata, and apply-action
operations. It checks the form token and revision on every request, caps request
bodies, projects schemas/properties/context, hides fixed/generated parameters,
checks object-reference inputs against form policy, and sets private/no-store.
Read policies include implicit context scoping, scalar predicates, and context-path
joins. A data manifest limits queryable types/link hops. The browser discovers a
schema/context dynamically, maintains a memory view partitioned by form, revision,
session and context object, and submits directly. Server-side ontology/metadata
leases can share trusted cached resources and also append observability events.
The existing client retains an idempotency key across submission attempts; a native
port must distinguish rejected input correction from retrying an unknown outcome.

This does not require exposing the internal base/outbox/overlay replication protocol
to public clients. Trusted cache plus scoped request/response authorization is the
appropriate initial composition. No Zero-style query watching is needed for parity.

## Native stateless API migration gates

Do not describe the new predicate wrapper as a drop-in replacement yet. Verify:

- Dynamic Describe now includes the projected ontology definition and shared typed
  context. Native live clients can discover both. Verify downstream generated-client
  expectations and invalidation on form/revision changes during the Gateway port.
- Native ResolveActionParameters now preserves the LiveOntology resolveParameters API.
  Storage bindings resolve through a read transaction; projected bindings evaluate
  permitted defaults through authorized row/property reads and hide fixed parameters.
  Verify gateway-specific prefill cases, including its join-based policies, during porting.
- Existing join-based policies, implicit context scope and query restrictions work
  before ordering/pagination. Static storage predicates alone do not cover all cases.
- Reference-input authorization, fixed/generated parameters, permitted query functions,
  and attachment permissions are rechecked per call, including on apply.
  Native attachment reads/metadata now re-find the handle in a projected source
  row/property. Staging authority, principal-bound transfers and upload limits remain gates.
- Form-token binding, revision fencing, request/transfer bounds, no-store behavior,
  validation issue projection and unknown-outcome handling survive the transport port.
- Token/context/revision changes cannot reuse a previously authorized cached view.
- Structured validation paths reach the downstream form field renderer. Automatic
  retries belong to Replica; a form must not introduce another independent executor.

Describe reports protocol version, sourceId, projected IR/context, supportsIdempotency,
changes, watchChanges, watchSubset, finite queries and actionParameterResolution. These are transport/source capabilities,
not permission grants or a complete feature inventory. A Foundry subset watcher does
not imply a resumable journal watch. sourceId identifies the upstream data/receipt
domain; it is separate from schema and form revisions.

Gateway's old bounded-body wrapper caps JSON at 1 MB and multipart at 25 MB. Party
Stack owns native chunking/staging. The native port should expose configurable total
request/upload and concurrent-transfer limits in the framework, with Gateway supplying
authorization/configuration. Bind uploads to a principal/form/revision and target;
reauthorize chunks and final action use. The public gateway currently has no standalone
eager upload endpoint. Future reads of an unreferenced staged upload require explicit
uploader authority; knowledge of an attachment ID alone is never sufficient. This is
authorization, separate from orphan GC grace and ordinary write intents.

The old HTTP APIs are deprecated but remain available until these gates pass. The
remote-notes example now uses native RPC and ordinary row predicates, and is not
proof that all gateway policies have been ported.

## Deferred changes and untrusted child replicas

projectOntologyBackend can expose a journal filtered by visible types/properties
when it has no row predicates. Row-filtered views currently use snapshots. Correct
filtered changes require before/after membership: a visible row moving out of scope
needs a delete, while a hidden row moving in needs a put, without disclosing hidden
rows, properties, cursor/receipt details or action parameters.

General replica-state authorization additionally projects base, inherited overlays,
pending/completed actions, action controls and coverage under one principal/revision.
It must repair or invalidate a view when authorization changes and prevent revealing
another client's speculative actions. Ordinary row access must never imply privileged
outbox/base inspection. This is deferred for the described gateway request/response
workflow, not treated as already implemented.

Protocol children now use ordinary row GC and local BlobStorage. Trusted memory
tabs receive selected snapshots and keep their own memory byte cache; their parent
is the remote byte provider. Demand, pins and own action dependencies protect rows;
transactional blob roots protect attachment identity and staged bytes. This removes
the earlier GC/blob guard, but does not authorize general untrusted speculative-state
access. Such access still needs the projection work described above.
