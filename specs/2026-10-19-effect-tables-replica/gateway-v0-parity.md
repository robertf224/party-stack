# Gateway migration gates and deferred protocol work

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

- Dynamic Describe includes the projected ontology definition and projected context.
  Native RPC currently describes source capabilities, while sample clients supply IR.
- Server-side parameter/default resolution preserves prefills and hides fixed values.
- Existing join-based policies, implicit context scope and query restrictions work
  before ordering/pagination. Static storage predicates alone do not cover all cases.
- Reference-input authorization, fixed/generated parameters, permitted query functions,
  and attachment permissions are rechecked per call, including on apply.
- Form-token binding, revision fencing, request/transfer bounds, no-store behavior,
  validation issue projection and unknown-outcome handling survive the transport port.
- Token/context/revision changes cannot reuse a previously authorized cached view.
- Structured validation paths reach the downstream form field renderer. Automatic
  retries belong to Replica; a form must not introduce another independent executor.

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

Protocol child replicas currently require gc:false and no local blob service. Trusted
memory tabs receive selected snapshots and use their persistent parent's attachment
service. Persistent children need transactional row roots from their own demand,
forwarded actions and imported parent dependencies, plus byte/alias retention and
crash recovery. Add selected-membership and parent-handoff stress tests before lifting
the guard. This is distinct from existing mark-and-sweep in an adapter-backed replica.
