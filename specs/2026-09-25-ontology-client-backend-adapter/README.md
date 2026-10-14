# Ontology client and backend adapter responsibilities

## Status

This document describes both:

1. a tactical `live: false` adapter mode that can ship independently; and
2. a longer-term split between direct ontology operations, one-shot typed queries,
   and live replicated state.

Only the tactical mode is part of the initial implementation. The remaining API
is a proposal intended for refinement.

## BLUF

`LiveOntology` should remain inherently live. It owns long-lived TanStack DB
collections, background replication, optimistic transactions, outbox behavior,
and reconciliation after actions.

Server requests need a different abstraction. A typed `OntologyClient` should
offer direct reads, one-shot TanStack-style queries, actions, validation, query
functions, and attachments without opening replication streams or owning
optimistic state.

`OntologyBackendAdapter` should ultimately expose backend primitives rather than
TanStack collection configuration. Ontology core should construct TanStack
collections, run replication, track checkpoints, and reconcile action receipts.

The immediate Cloudflare issue is fixed before that refactor by constructing the
Foundry adapter with `live: false`.

```ts
const backendAdapter = createFoundryOntologyBackendAdapter({
    client: foundryClient,
    ir,
    live: false,
});

const server = createRemoteOntologyServer({
    ir,
    backendAdapter,
    policy,
});
```

For now, `createRemoteOntologyServer` still creates temporary `LiveOntology`
instances internally. A non-live Foundry adapter makes those instances bounded:
object collection startup does not construct an object-set watcher or WebSocket,
and actions do not wait for their operation IDs to return through synchronization.

## Problem

The current backend boundary combines four responsibilities:

1. backend reads and writes;
2. TanStack DB collection construction;
3. long-running replication lifecycle; and
4. post-action local-cache reconciliation.

`OntologyBackendAdapter.getCollectionOptions()` returns TanStack collection
configuration. Backend `applyAction()` implementations receive live collections
and may wait for those collections to observe the action.

For Foundry, starting collection sync calls
`getObjectSetWatcherManager(client)`. Constructing that manager starts a
permanent Effection task and WebSocket. A request-scoped remote ontology server
therefore starts a long-lived resource while handling an otherwise finite HTTP
request. OpenNext retains the handler through Cloudflare `ctx.waitUntil()`, so
the request can remain alive until Cloudflare cancels it.

The current shape also forces remote ontology handlers to construct a complete
`LiveOntology` for operations that only require a direct query or action.

## Goals

- Fix request-scoped Foundry use without runtime or user-agent detection.
- Preserve existing live behavior by default.
- Keep `LiveOntology` semantically live.
- Add a typed, non-reactive `OntologyClient`.
- Support typed one-shot queries using TanStack DB query syntax.
- Allow adapters to push down complete query plans, including aggregations.
- Centralize replication lifecycle and action reconciliation in ontology core.
- Permit different backend observation mechanisms without putting functions in
  serializable action receipts.
- Make query invalidation possible even when full row-level synchronization is
  unavailable.

## Non-goals

- Implement the complete `OntologyClient` and replication redesign in the
  tactical change.
- Automatically split arbitrary query plans between backend and local execution
  in the first query implementation.
- Guarantee realtime invalidation when a transport supplies no stream, polling,
  or external invalidation mechanism.
- Treat TanStack DB's private query IR as a stable network protocol.

## Tactical Foundry mode

### Construction

Add `live?: boolean` to:

- `createFoundryOntologyBackendAdapter`;
- `CreateFoundryOntologyBackendOptions`;
- `createFoundryOntologyRoute`;
- `ObjectCollectionOpts`; and
- relevant typed collection option overloads.

The default is `true`.

```ts
interface CreateFoundryOntologyBackendAdapterOptions {
    client: FoundryOntologyClient;
    ir: OntologyIR;
    users?: FoundryUsersIntegration;
    live?: boolean;
}
```

### `live: true`

This preserves current behavior:

- collection sync constructs the object-set watcher;
- watcher messages trigger edit-history catch-up or direct updates;
- reconnect requests synchronization;
- Foundry actions wait for their operation IDs in affected active collections;
- collection cleanup unsubscribes its watcher subscription.

### `live: false`

This is intended for finite request/response use:

- collection sync must not call `getObjectSetWatcherManager`;
- no object-set subscription or WebSocket is created;
- `loadSubset` remains available;
- direct edit-history catch-up remains available when explicitly requested;
- actions, validation, query functions, and attachments remain available;
- `applyAction` resolves after Foundry accepts the action and does not call
  collection `awaitOperationId`;
- cleanup remains valid and idempotent.

The conditional must surround manager construction, not only subscription:

```ts
const unsubscribe = live
    ? getObjectSetWatcherManager(client).subscribe({ type: "base", objectType }, handleObjectSetMessage)
    : () => {};
```

The manager constructor starts the permanent task, so this is incorrect:

```ts
const manager = getObjectSetWatcherManager(client);
const unsubscribe = live
    ? manager.subscribe(...)
    : () => {};
```

### Transitional use by remote ontology

The initial remote server integration remains:

```text
HTTP request
  -> RemoteOntologyServer
  -> temporary LiveOntology
  -> Foundry adapter configured with live: false
  -> bounded reads/action
  -> cleanup
```

This is deliberate transitional debt. It fixes the production lifecycle issue
without waiting for `OntologyClient`.

A non-live adapter must not be used for optimistic action visibility. TanStack
keeps an optimistic layer until its transaction mutation function resolves. If
the adapter returns immediately after backend acceptance, TanStack could drop
the optimistic layer before authoritative synchronized state replaces it.
During the transition, confirmed actions are supported and optimistic actions
with a non-live adapter should be rejected.

### Other adapters

The flag has behavior only where an adapter owns live reconciliation:

- Salesforce `live: false` suppresses CDC subscription and skips post-action
  record refresh, deletion, and collection invalidation.
- The remote HTTP adapter has no stream today, but `live: false` skips its
  post-action query refetch while preserving invalidation metadata and attachment
  mappings in the returned result.
- SQLite performs a bounded local database load and commits actions directly
  into its local TanStack collections and database. It needs no non-live branch.
- Durable Object delegates to SQLite and likewise needs no branch.
- Local, Foundry, and Salesforce metadata adapters are read-only and create no
  object-change stream requiring this flag.

## Target architecture

### Layers

```text
OntologyBackendAdapter
  backend primitives and capabilities
        |
        +--> OntologyClient
        |      typed direct operations and one-shot queries
        |
        +--> LiveOntology
               typed reactive collections, replication, optimistic writes,
               outbox, and reconciliation
```

The two public facades should feel similar, but their guarantees differ.

### Typed `OntologyClient`

`OntologyClient` should use the generated `OntologyDefinition` in the same way
as `LiveOntology`.

```ts
interface OntologyClient<Ontology extends OntologyDefinition = OntologyDefinition> {
    readonly ir: OntologyIR;
    readonly context: OntologyContext<Ontology>;

    objects: OntologyClientObjects<Ontology["objectTypes"]>;
    actions: OntologyClientActions<Ontology["actionTypes"]>;
    queryFunctions: OntologyClientQueryFunctions<Ontology["queryFunctionTypes"]>;
    attachments: OntologyClientAttachments<Ontology>;

    query<T>(
        build: (
            q: InitialQueryBuilder,
            objects: OntologyQueryObjects<Ontology["objectTypes"]>
        ) => QueryBuilder<T>
    ): Promise<T>;

    cleanup(): Promise<void>;
}
```

Example:

```ts
const note = await client.objects.Note.get("note-1");

await client.actions.updateNote({
    note: "note-1",
    title: "Updated",
});

const counts = await client.query((q, objects) =>
    q
        .from({ note: objects.Note })
        .where(({ note }) => eq(note.ownerId, client.context.user))
        .groupBy(({ note }) => note.status)
        .select(({ note }) => ({
            status: note.status,
            count: count(note.id),
        }))
);
```

Client actions are direct and confirmed. `OntologyClient` has no optimistic
projection, outbox, or promise whose lifetime depends on replicated local state.

The existing Foundry SDK wrapper already exports a type named `OntologyClient`.
The implementation will need to alias or eventually rename that provider-specific
type, for example `FoundryOntologyClient`, when both APIs appear in one module.

### `LiveOntology`

`LiveOntology` remains the long-lived API:

```ts
interface LiveOntology<Ontology extends OntologyDefinition> {
    readonly ir: OntologyIR;
    readonly context: OntologyContext<Ontology>;
    readonly ready: Promise<void>;

    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
    queryFunctions: LiveOntologyQueryFunctions<Ontology["queryFunctionTypes"]>;
    attachments: LiveOntologyAttachments<Ontology>;

    query<T>(
        build: (
            q: InitialQueryBuilder,
            objects: LiveOntologyObjects<Ontology["objectTypes"]>
        ) => QueryBuilder<T>
    ): Promise<T>;

    outbox: OntologyOutbox;
    cleanup(): Promise<void>;
    destroy(): Promise<void>;
}
```

`LiveOntology.query()` executes against its long-lived TanStack collections.
Queries may activate on-demand subset loading. Aggregations are correct only
when the query engine can establish complete input for the requested plan.

## Target backend primitives

The eventual adapter surface should express operations and capabilities rather
than supplying a complete TanStack collection.

```ts
interface OntologyBackendAdapter {
    readonly name: string;

    loadSubset(
        objectType: string,
        options: LoadSubsetOptions,
        operation?: OntologyOperationOptions
    ): Promise<ObjectBatch>;

    executeQuery?<T>(
        plan: OntologyQueryPlan,
        operation?: OntologyOperationOptions
    ): Promise<BackendQueryResult<T>>;

    pull?<Checkpoint>(
        objectType: string,
        request: PullRequest<Checkpoint>,
        operation?: OntologyOperationOptions
    ): Promise<ChangeBatch<Checkpoint>>;

    stream?<Checkpoint>(
        objectType: string,
        request: StreamRequest<Checkpoint>,
        operation?: OntologyOperationOptions
    ): AsyncIterable<ChangeBatch<Checkpoint> | Resync>;

    compareCheckpoints?(objectType: string, current: unknown, target: unknown): boolean;

    applyAction(
        name: string,
        parameters: Record<string, unknown>,
        operation: ApplyActionOptions
    ): Promise<ActionReceipt>;

    validateAction?(...args: unknown[]): Promise<ActionValidation>;
    validateActionDraft?(...args: unknown[]): Promise<ActionValidation>;
    runQueryFunction(
        name: string,
        parameters: Record<string, unknown>,
        operation?: OntologyOperationOptions
    ): Promise<unknown>;

    attachments?: OntologyAttachmentsAdapter;
    cleanup?(): void | Promise<void>;
}
```

Representative operation types:

```ts
interface OntologyOperationOptions {
    signal?: AbortSignal;
    context?: Record<string, unknown>;
}

interface ObjectBatch {
    objectType: string;
    objects: Record<string, unknown>[];
    complete: boolean;
}

interface PullRequest<Checkpoint> {
    checkpoint: Checkpoint | null;
    limit: number;
}

interface ChangeBatch<Checkpoint> {
    changes: ObjectChange[];
    checkpoint: Checkpoint;
    caughtUp: boolean;
    observedActionKeys?: string[];
}

type Resync = {
    type: "resync";
    reason?: "reconnect" | "gap" | "unknown-change" | "manual";
};
```

Checkpoint types remain backend-owned. Ontology core persists a checkpoint only
after the corresponding TanStack commit succeeds.

## One-shot query plans

### Shared syntax

Both facades should accept the same TanStack-style builder:

```ts
await ontology.query((q, objects) =>
    q
        .from({ issue: objects.Issue })
        .join({ project: objects.Project }, ({ issue, project }) => eq(issue.projectId, project.id))
        .where(({ issue }) => eq(issue.status, "open"))
        .select(({ issue, project }) => ({
            issueId: issue.id,
            title: issue.title,
            projectTitle: project.title,
        }))
);
```

`objects` supplied to `OntologyClient.query()` are typed symbolic query sources,
not long-lived replicated collections.

### Versioned plan

The current code accesses TanStack's private `BaseQueryBuilder._getQuery()`.
That representation must not become the remote protocol.

Ontology core should convert the builder into a versioned, validated plan:

```ts
interface OntologyQueryPlanV1 {
    version: 1;
    sources: Record<string, { objectType: string }>;
    joins?: OntologyQueryJoin[];
    where?: OntologyQueryExpression[];
    groupBy?: OntologyQueryExpression[];
    having?: OntologyQueryExpression[];
    orderBy?: OntologyQueryOrder[];
    select: Record<string, OntologyQueryExpression>;
    limit?: number;
    offset?: number;
}
```

The exact fields should follow supported TanStack semantics, but conversion and
wire validation must be isolated from TanStack internals.

### Execution

Execution order:

1. Build and validate an `OntologyQueryPlan`.
2. Compose authorization and fixed policy predicates.
3. Ask `adapter.executeQuery` to execute the complete plan.
4. If unsupported, determine whether all required source rows can be loaded
   completely through `loadSubset`.
5. If complete hydration is possible, evaluate the plan locally with TanStack.
6. Otherwise return an explicit unsupported-query error.

The first implementation should use all-or-nothing native pushdown or complete
local fallback. Partial plan splitting requires a query planner and cost model
and is deferred.

### Aggregations

Aggregations make completeness observable. Counting a partial on-demand cache
silently returns an incorrect result.

An aggregate may execute only when:

- the adapter pushes down the complete aggregate plan; or
- core proves that every matching input row has been loaded.

Authorization predicates must run before grouping and aggregation. Counts,
minimums, maximums, and group existence can leak restricted rows even when
selected object properties are hidden.

## Action receipts and reconciliation

### Accepted action result

Backend `applyAction` means that the backend accepted or executed the command.
It returns serializable facts:

```ts
interface ActionReceipt {
    attachmentIdMappings?: OntologyAttachmentIdMapping[];

    effects?: ActionEffect[];
    authoritativeChanges?: AuthoritativeObjectChange[];
    observations?: ActionObservation[];
}

interface ActionEffect {
    objectType: string;
    scope: { kind: "keys"; keys: Array<string | number> } | { kind: "unknown" };
}

interface ActionObservation {
    objectType: string;
    key?: string;
    checkpoint?: unknown;
}
```

Receipts contain no closures. They may cross HTTP, be retained by an outbox,
and be logged or replayed.

### Reconciliation order

For a live ontology, core uses the strongest available evidence:

1. install complete authoritative changes returned with the action;
2. wait for normalized action evidence or a checkpoint barrier;
3. reload exact affected keys;
4. invalidate and refetch active subsets for affected object types.

An empty effects list represents an action known not to affect ontology objects.

### Observation normalization

Backends can expose causation differently:

- Foundry operation IDs occur in edit-history entries.
- Another backend may place an action ID on each changed row.
- A change stream may carry the ID in an event envelope.
- A database may return a commit LSN or replay checkpoint.
- An action endpoint may return complete canonical changed rows.

Adapters normalize the first three into `ChangeBatch.observedActionKeys`.
Watermark-based adapters return an observation checkpoint and implement
`compareCheckpoints`.

Foundry example:

```ts
// applyAction
return {
    effects: editedObjectTypes.map((objectType) => ({
        objectType,
        scope: { kind: "unknown" },
    })),
    observations: editedObjectTypes.map((objectType) => ({
        objectType,
        key: `foundry:${operationId}`,
    })),
};

// pull edit history
return {
    changes,
    checkpoint,
    caughtUp,
    observedActionKeys: entries.map((entry) => `foundry:${entry.operationId}`),
};
```

The central replicator:

1. registers receipt barriers;
2. requests catch-up for affected active collections;
3. applies a change batch;
4. awaits the TanStack commit receipt;
5. marks the batch's action keys/checkpoint as observed; and
6. resolves reconciliation waiters.

Seeing a token before commit is insufficient. An optimistic transaction may
settle only after authoritative state has committed into TanStack.

### Accepted versus reconciled failure

If an action is accepted but reconciliation later times out, the action did not
fail. A reconciliation error should retain the accepted receipt so callers and
outboxes do not treat the command as unexecuted. Idempotency remains required,
but it is not a substitute for representing this distinction.

## Query dependencies and refresh

One-shot queries can be cached without pretending to replicate their result.
Each plan has a dependency footprint:

```ts
interface QueryDependency {
    objectType: string;
    scope:
        | { kind: "keys"; keys: Array<string | number> }
        | { kind: "predicate"; expression: OntologyQueryExpression }
        | { kind: "unknown" };
}
```

Action effects and replication events intersect with cached dependencies:

- exact-key effects invalidate queries that may contain those keys;
- unknown/type-wide effects invalidate every query depending on that type;
- aggregates generally invalidate on any relevant type-level effect;
- authoritative changes may permit future incremental cache maintenance.

Without a stream, changes made elsewhere cannot be known immediately.
`OntologyClient` must support explicit refetch and may use TTL, polling, or a
future lightweight invalidation stream. Action receipts cover changes initiated
through the same client.

## Remote ontology

### Tactical

The application constructs its server-side Foundry adapter with `live: false`.
No remote protocol change is required.

### Target

Remote server handlers use `OntologyClient`:

```text
describe                  -> projected typed metadata
load-subset               -> client.objects[type].loadSubset
execute-query             -> client.query
validate-action           -> client.actions[type].validate
resolve-action-parameters -> direct client query/parameter resolver
apply-action              -> client.actions[type]
run-query-function        -> client.queryFunctions[type]
attachments               -> client.attachments
```

No handler creates a `LiveOntology`.

The browser-side remote adapter remains usable by `LiveOntology`. It maps
remote action receipts to client-side cache reconciliation. It may also expose
`OntologyClient` directly for applications that need typed one-shot operations
without replicated object state.

## Migration

1. Add `live?: boolean`, defaulting to true, to adapters with live reconciliation.
2. Set `live: false` for Foundry, Salesforce, or remote adapters used by remote
   ontology servers.
3. Prove non-live collection startup never constructs the watcher.
4. Add direct adapter `loadSubset` and accepted `applyAction` primitives.
5. Add typed `OntologyClient` over those primitives.
6. Move remote server handlers from temporary LiveOntology to OntologyClient.
7. Add the versioned one-shot query plan and whole-plan adapter pushdown.
8. Move TanStack collection construction into ontology core.
9. Add centralized pull/stream/checkpoint orchestration.
10. Move Foundry operation-ID waiting into receipt reconciliation.
11. Migrate Salesforce, remote, and SQLite adapters to backend primitives.
12. Remove the tactical Foundry `live` branch if the primitive split makes it
    redundant.

## Tactical tests

- Omitted/true `live` constructs the manager after collection sync starts.
- Live collection cleanup unsubscribes.
- `live: false` never calls `getObjectSetWatcherManager`.
- `live: false` still serves `loadSubset`.
- Explicit non-live `awaitOperationId` can perform bounded edit-history catch-up.
- Live Foundry actions await affected collection operation IDs.
- Non-live Foundry actions do not invoke collection `awaitOperationId`.
- Non-live Salesforce collections do not subscribe to CDC and actions do not
  refresh or invalidate temporary collections.
- Non-live remote actions preserve result metadata without refetching temporary
  query collections.
- Adapter provider and route helpers forward `live`.
- Optimistic action submission rejects a non-live adapter during the transitional
  remote-server implementation.

## Open questions

1. Should the provider-specific `@party-stack/foundry-client` type be renamed to
   `FoundryOntologyClient`, or only aliased internally?
2. Should `OntologyClient.objects.Note` expose `get`, `loadSubset`, and
   object-scoped query helpers in addition to global `client.query`?
3. Which TanStack query features are included in query plan V1?
4. Should unsupported native queries fall back automatically when hydration may
   be expensive, or require an explicit execution preference?
5. How are query cost, maximum scanned rows, and aggregate limits enforced on a
   remote server?
6. Should remote query results include dependency metadata from the server or
   should clients derive it solely from the submitted plan?
7. What is the protocol representation for backend-owned checkpoints?
8. Do inactive collections participate in action reconciliation, or only
   collections with local state?
9. How should accepted-but-unreconciled errors interact with outbox retries?
10. Should a lightweight invalidation-only stream belong to `OntologyClient`,
    or remain a `LiveOntology` capability?
