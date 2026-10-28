# Query IR and authorized ontology views — initial proposal

October 28, 2026. Research/design only; the APIs below are illustrative and are not
implemented exports. This develops [query-ir.md](./query-ir.md) using Streamline's
actual integration and the two referenced design conversations.

## Recommendation

Use one portable relational query model for ordinary reads, nested result
selections, policy read graphs and offline demand. A policy interprets selected
entity fields as read grants; a UI query interprets them as an output shape.
Authorization and UI fragments are compositions over that model, not separate
expression languages. A query by itself grants no authority.

Keep three descriptions distinct:

1. The logical query: what data/relationships/values are requested.
2. The authorized plan: which reads and cells this caller is permitted to observe.
3. The physical plan: SQL, indexed subset batches, local evaluation, and later IVM.

Keep the IR in ontology-spec, execution/lowering alongside storage/backend code,
server policy composition in ontology-server, and collection readers in ontology.
No additional package is needed to start. The wire format contains data, never
closures, Effect values, React components or TanStack Collection instances.

## Evidence from the existing applications

Inspected the local Streamline checkout without changing it:

- `streamline-ontology/src/ontology/ontology.ts` already has Project → Form →
  FormRevision and Project → Workspace → WorkspaceRevision links. Error events
  have `formId`; the desired policy must also cover form sessions. Missing named
  links can be added or expressed through explicit correlations.
- Studio's `useIsStreamlineAdmin` currently probes an action's validation result.
  The inspected project definition has no project-membership model. Project-level
  admin membership in the examples below is a proposed ordinary object/link,
  not an existing capability we discovered.
- `streamline-spec/SecurityPolicy.ts` has per-type property lists, scalar filters,
  and optional context link paths. `streamlineRemoteOntologyPolicy.ts` turns some
  paths into TanStack inner joins, separately compiles scalar filters, applies
  implicit context scoping, fixes/generated parameters, checks reference inputs,
  and restricts callable actions/query functions.
- Gateway authenticates a form token/revision on each call, derives trusted
  context, bounds requests, and uses a finite projected ontology. That workload
  does not need public speculative-state replication or live full-query watching.

The replacement must preserve those behaviors while allowing general nested
correlations, both relationship directions and composition across several hops.

## Documents can have multiple roots

A query document is a root selection with no required starting object type. Its
named entries can independently query any permitted source, including the same
object type with different arguments/windows. Each relational query inside it
still has an explicit source/binding.

```ts
const tokenReadDocument = select({
    approval: tokenRead,
    posts: q.Post.select((post) => ({ id: post.id, name: post.name })),
});
```

Here `tokenRead` is the contextual approval graph from Example 2. The second root
grants all Posts' selected location fields independently of that approval. The
same document/selection structure works for policy grants and ordinary UI reads.
Names are output aliases, not extra authorization scopes. This is also how an
app can ask for current user, projects and global reference data together.

One document does not require one request per root. Independent roots can batch or
run concurrently, subject to a shared work budget. Owned execution uses one read
snapshot for all roots; a document spanning external providers cannot promise a
shared database snapshot. Identical roots may share execution, but distinct
filters, cardinality and windows must preserve their separate result semantics.

## Example 1: project administrators

Names are shortened for readability. Following the proposed Streamline model,
assume a Project.adminUserIds array. Membership is an ordinary typed expression;
it need not be a dedicated object type.

```ts
const adminProjects = q.Project.where((project) =>
    contains(project.adminUserIds, context("principal.userId"))
);

const projectAdminRead = adminProjects.select((project) => ({
    ...fields(project),
    forms: related(project, "forms").select((form) => ({
        ...fields(form),
        revisions: related(form, "revisions").select(fields),
        sessions: related(form, "sessions").select(fields),
        errors: related(form, "errorEvents").select(fields),
    })),
    workspaces: related(project, "workspaces").select((workspace) => ({
        ...fields(workspace),
        revisions: related(workspace, "revisions").select(fields),
    })),
}));
```

`fields` is illustrative explicit select-all sugar. Explicit property selections
are the safer default; select-all deliberately grants newly added properties too.
The membership expression determines access without automatically exposing the
admin array. Only selected entity fields become public read grants. A separate
membership object or provider group query is equally representable if the app
later needs roles, invitation metadata or membership-specific history. Policies
must not require that schema choice.

The result defines a view in which accessible forms can also be queried directly:

```ts
q.Form.where((form) => ilike(form.title, input("search")))
    .orderBy((form) => form.updatedAt, "desc")
    .limit(20);
```

The server derives the appropriate Form → Project → matching admin-array restriction.
It does not require loading every project/form before running the caller's query.
It also does not require clients to start every query at Project.

## Example 2: a Post Approval token

Authentication produces a typed context object reference. The caller cannot
replace this reference by sending a different query parameter or header.

```ts
const tokenRead = q.PostApproval.where((approval) => eq(approval.id, context("postApproval.id"))).select(
    (approval) => ({
        id: approval.id,
        status: approval.status,
        person: related(approval, "person").select((person) => ({
            id: person.id,
            name: person.name,
        })),
        bids: related(approval, "bids").select((bid) => ({
            id: bid.id,
            post: bid.post,
            status: bid.status,
        })),
    })
);
```

Only the selected approval, linked person's selected fields, and matching bids
are exposed. Being able to see Person.name does not grant Person.email, or access
to every person. A direct Person query gets the same restriction as a nested read.
Traversable link definitions are projected too; knowing two visible IDs does not
grant a hidden named relationship. Explicit joins may only use caller-readable
fields. Trusted policy correlations may use hidden foreign keys internally.

The policy envelope can compose this with action capabilities:

```ts
const tokenReadBids = q.Bid.where((bid) => eq(bid.postApprovalId, context("postApproval.id")));

const policy = {
    name: "post-approval-token",
    contextType: o.ref({ name: "PostApprovalTokenContext" }),
    read: tokenReadDocument,
    actions: {
        submitPostApproval: {
            check: literal(true),
            bind: { postApproval: context("postApproval") },
        },
        withdrawBid: {
            bind: { postApproval: context("postApproval") },
            check: (parameters) => tokenReadBids.contains(parameters.bid),
        },
    },
};
```

This sketches construction, not a finalized callback API. Builder callbacks
produce serializable check expressions; functions themselves are never stored in
OntologyIR. The server hides and binds fixed parameters;
a conflicting caller value is rejected, never allowed to choose a different context.
Object-reference parameters are checked through the authorized view. The action
policy's check is its grant: a literal true permits that action for the selected
policy context. An action without a successful applicable rule is denied. There
is no parallel action allowlist to keep synchronized. The read grant does not
imply permission to mutate its objects.

## Policies belong in OntologyIR; authentication supplies their context

Add serializable PolicyDef entries to OntologyIR. A policy references a typed
context and contains a multi-root read document plus per-action check/bind
expressions. Global business validation on ActionTypeDef remains distinct from
an authorization check, even though both reuse the expression/query vocabulary.
The former produces ValidationFailed issues; the latter uses the configured
authorization-error projection.

There is no mandatory User object or hardcoded `context.user`. A named context
could describe an authenticated Studio user, a Post Approval token, an automation
identity or an unauthenticated public endpoint. The trusted authentication binding
selects the policy instance and validates/fills its context. A client cannot choose
its policy or claim a token type by supplying that value in a request. One policy
can cover many users/tokens through context references, rather than requiring a
separate definition per identity.

An application may compose policy instances, but fixed-parameter conflicts must
be resolved explicitly, not by last-write-wins object merging. The binding also
supplies an opaque authorization/cache scope key: principal, context, policy and
schema changes must not reuse another authorized view. Current user-specific
convenience defaults are not a semantic requirement of the new IR.

Keep the canonical action security rules with their enclosing PolicyDef: different
principal/token contexts can check/bind the same action differently, and their
read grants can be composed together. ActionTypeDef owns parameters, implementation
and principal-independent business validation. Definition builders may offer
action-colocated sugar, but emit one canonical policy reference rather than
duplicate executable rules in both places. Global business constraints still
apply when a policy's authorization check is true.

### Storage partitioning and expression context

Retain explicit owner/partition identity, even when a context has no User object.
Today installations partition by user/ontology, Runtime exposes owner/namespace,
and owned action receipt scoping still has a context.user convenience default.
Generalize those identity defaults; do not discard the isolation they provide.

For client replicas/private caches, reuse Runtime.owner for stable authenticated
ownership and namespace for source/ontology plus tenant/form/context scope where
required. A token/service principal is still an identity. Use a validated stable
identifier or an opaque local session key, not a bearer secret in a database name.
The authentication binding supplies both this partition identity and the typed
expression context; neither is inferred by serializing arbitrary context fields.

Different identities or security contexts must not accidentally share private
base rows, decrypted copies, byte caches or outboxes. Shared authoritative storage
and trusted server caches remain shared; request-scoped authorized views sit over
them instead of creating a database for every caller.

Policy/schema revisions invalidate or migrate the existing view and coverage.
They must not automatically select a fresh physical partition and strand pending
actions. Retain the outbox under its stable ownership, then revalidate incompatible
work. Logging in as another identity must never dispatch that outbox as the new
identity. Storage separation is local isolation, not a substitute for server auth.

OntologyIR already has contextType. Keep it as a typed environment, potentially
containing principal, tenant, organization, token/form/context-object references
and other explicitly declared trusted inputs. Each policy can use a compatible
context type. A useful conventional principal field is fine; context need not
be identical to a User record. A tenant supplied here must still be authenticated
or authorized for this principal; an arbitrary request value is not trusted merely
because it is placed in context. Project only permitted context back to clients.

Extend the schema metadata with a principal path alongside contextType (working
name `contextPrincipal: ["actor"]`). Resolve that path from validated trusted
context to a stable scalar identity or canonical object reference; do not hash the
entire context. Existing installations can keep supplying context.user and use
that convention by default. A token-context policy can instead identify its token
subject. The principal identifies who is invoking, not merely the token's creator.
An absent/invalid declared principal is a binding error, not fallback to a shared
anonymous owner. Explicit public/system bindings can supply their own owner.

The schema declaration guides the authentication binding; it is not evidence that
an untrusted request's identity is authentic. Reconcile it with the connected
account/validated token. Keep tenant/form/approval scope in the binding's stable
namespace/view scope; equal principals can still have different permitted views.
Per-policy context metadata can specialize the default context declaration. This
generalizes the existing user-ID path rather than replacing installation identity
and Runtime ownership with a new unrelated identity system.

### Query construction references

The short helpers in this note are proposed query-builder APIs. Today field() is
exported by ontology-storage, and ontology-spec's generated expression constructors
already have inputReference/contextReference/localReference/getAt. Unify the query
helpers in a portable ontology-spec/query export, with schema-aware construction
in ontology rather than creating a new package.

| Reference               | Meaning                                                        | Who supplies the value                     |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| input("search")         | Declared query input; action parameter in an action expression | Caller, validated at the boundary          |
| context("tenant")       | Declared bound environment value                               | Trusted authentication/application binding |
| field(binding, "title") | Property of the current or outer bound row                     | Query execution                            |
| literal("open")         | Constant value                                                 | Query definition                           |

Use typed proxies for row/input/context references where they improve inference;
explicit helpers serve programmatic construction and compile to the same nodes.
The existing storage field("title") shorthand is unambiguous for a single table;
multi-source query references need binding identity. related(), comparisons,
boolean/list operators and when() compose those references. These are construction
operations, not effects or immediate reads. UI constants can also be bound through
validated arguments without requiring users to hand-build AST nodes.

For Foundry-targeted deployments, lower compatible action checks to
[submission criteria](https://www.palantir.com/docs/foundry/action-types/submission-criteria).
Foundry supports logical combinations of parameter/current-user/execution-context
conditions. The compiler should report which checks are represented, which need
generated function logic, and which remain enforced at the gateway. It must not
silently omit unsupported authorization. A deployment without an enforcement
location for a required check fails rather than merely warning and dropping it.

A Streamline-only token is not Foundry's current user when Gateway calls using a
service user. Preserve the checks at the Streamline boundary unless an equivalent
trusted context is available in Foundry. Forwarding an unsigned caller-controlled
parameter does not make that context trustworthy. Foundry then independently
enforces the permissions/criteria applicable to its service-user invocation.

## Authorization semantics

Conceptually, a read graph yields:

```text
source + object type + primary key → permitted property set
                                    permitted relationship traversals
```

Identity is retained even if not explicitly rendered. Multiple paths/rules within
one policy union their read grants by entity/cell identity. Nested shaping does
not clone entities or make permission depend on the caller's result alias.
Initially grant projections select actual entity properties and nested entities.
A computed output does not grant access to its raw inputs; derived-property or
query-function capabilities must make such transformations explicit.
Outer server/tenant/token/upstream restrictions intersect with that policy;
they are not additional union grants. Do not combine credentials into a broader
principal implicitly. Default is no access.

Rewriting must apply the view at every source occurrence: root scans, joins,
correlated subqueries, relationship projections, reference checks and authorized
query-function reads. Otherwise a caller can bypass policy through another alias.
Policy-only dependencies are evaluated in an explicit trusted scope, not recursively
through the public view; they are not sent to the caller. Reject unsupported policy
cycles initially rather than inventing recursive/fixed-point authorization.

This gives the reference semantics:

```text
authorizedView = evaluateReadGrants(trustedSnapshot, policy, trustedContext)
answer         = evaluateClientQuery(authorizedView, clientQuery, clientInputs)
```

Both operations run on the trusted server or in tests. Sending privileged data to
the browser and asking it to filter is not an implementation of authorization.
An eager server materialization of a small authorized view is a valid execution
strategy and a useful reusable cache.

## Entity selections versus result projections

Keep one selection/query vocabulary, with different validated uses. UI projections
may alias and compute values. Policy grants use a source-preserving entity
selection: every granted field identifies the source binding/property definition,
and its output name must equal that property name. A nested entity selection
retains source identity, primary key and relationship provenance. Root aliases
such as `approval` and `posts` remain freely nameable.

Use the same select/when syntax, with a declared purpose/use-validation mode when
the query is bound as a policy grant or an entity pin. No separate selectEntity
syntax is required. The policy/pin constructor can guide TypeScript inference;
validate the serialized tree too. Checking the name alone is insufficient: `name: person.ssn` must
not become a grant for Person.name. Literals and computed values cannot masquerade
as stored entity fields. Guarded selections can wrap entity fields/subtrees while
preserving their identities. Ordinary select remains the general UI projection.

Offline pins can accept entity selections directly. Pinning a UI projection can
also be useful, but retains its original source-property/relationship/window
dependencies, not an invented row made from output aliases. A computed label
therefore pins the fields used to compute it. It never authorizes additional
reads, and hidden policy dependencies are retained only on the trusted side where
they are available. This avoids unnecessarily banning useful UI-query pinning.

## Property policies

Express property policies as conditional selections within the same hierarchical
policy document. This avoids an independent property-policy configuration:

```ts
q.Person.select((person) => ({
    id: person.id,
    name: person.name,
    ...when(canReadPII(person), {
        email: person.email,
        ssn: person.ssn,
    }),
}));
```

`canReadPII` constructs an ordinary condition expression. `when` constructs a
guarded selection: its fields are granted only when the enclosing row/path is
authorized AND the condition passes. Nested guards conjoin along that path;
alternative grant paths union their permitted cells. Keep primary keys available
for every readable entity. Unknown/missing context cannot become a successful
grant. Required authorization inputs must be resolved, or access denied/failed.

[Foundry](https://www.palantir.com/docs/foundry/object-permissioning/object-security-policies/)
uses an object policy plus additional property policies, requiring both to pass.
It returns null for a denied property; it also excludes primary keys from property
policies. We should borrow the conjunction, not automatically adopt its null encoding.

Share condition expressions with normal scalar case/branching, but distinguish
the output operations. A scalar case chooses a value; a guarded selection
includes or omits fields/subtrees. Returning null from SQL CASE alone does not
encode cell readability. SQL lowering may use CASE plus presence/readability
metadata, while other executors directly evaluate the conditional selection.

Proposal: omit unavailable properties from projected results and admit that
possibility in projected types/codecs. Track availability internally so policy
redaction is distinct from a legitimate undefined value or a field never loaded.
Do not mutate the underlying ontology property's declared scalar type to null.

Dropping the value only at serialization is insufficient. Caller filtering,
ordering, correlation and aggregates must not inspect a denied cell. Statically
forbidden fields are rejected. For a dynamically guarded field, v0 can reject
operations on that field unless the query is proven to operate only on rows where
it is readable. This conservative rule avoids turning predicates into an oracle;
more permissive cell-aware query semantics can follow later. Trusted policy checks
can still use their explicit private inputs.

## Portable Query IR

The following is a structural sketch, not the final TypeScript definition:

```ts
type Query = {
    from: { source: SourceRef; binding: BindingId };
    joins?: readonly {
        kind: "inner" | "left";
        from: { source: SourceRef; binding: BindingId };
        on: Expression;
    }[];
    where?: Expression;
    select: Selection;
    orderBy?: readonly Order[];
    page?: { limit?: number; offset?: number; after?: Cursor };
};

type QueryDocument = {
    select: Selection;
};

type Selection = readonly (
    | { kind: "field"; name: string; value: Expression }
    | {
          kind: "query";
          name: string;
          query: Query;
          cardinality: "one" | "many";
      }
    | {
          kind: "when";
          condition: Expression;
          then: Selection;
          otherwise?: Selection;
      }
)[];
```

- SourceRef names a logical ontology/source slot and object type, resolved to an
  authorized binding at execution. It is not a SQL identifier supplied by clients.
  This permits outbox → action-type metadata joins across ontology instances.
- Expression extends ontology-spec's existing input/context/local references,
  literals, property paths and navigation with closed, typed comparison/boolean
  operators and query quantifiers. Existing storage predicates lower from this
  vocabulary instead of defining another competing operator set.
- Local references use explicit lexical binding identity. Nested queries may
  capture ancestor bindings; aliases for output properties do not determine scope.
- `some`/`none` are general query tests, lowered to semijoins/antijoins. They are
  not a separate public policy language or an exists-only authorization API.
- `related` resolves a named link to child source, correlation and directional
  cardinality. Explicit correlations produce the same relational plan. Existing
  related expressions can lower into these reads when their evaluation context
  permits queries; this does not enable arbitrary reads in every expression context.
- Nested ordering/limits are per parent. A singular result and a plural result
  limited to one remain different shapes. To-one relationships are optional when
  the target is absent or unreadable; uniqueness/cardinality is validated.
- Preserve portable Temporal/value codecs and existing undefined semantics.
  Queries are read-only: no uuid generation or ambient effects while evaluating.
  Aggregates can be a subsequent extension, with explicit grouping/result semantics.

The builder's proxy objects exist only during construction. Serialize/validate
the resulting AST at infrastructure boundaries. Canonical hashes normalize binding
names while preserving source identity, cardinality, values, ordering and parameters.

## Planning and the eager oracle

For a project admin, these are equivalent logical ways to find visible forms:

```text
Forms → Project → test Project.adminUserIds
matching Projects by adminUserIds → Forms
```

The second starts from the permitted project set. A membership-object variant
could instead start from a selective user/role index. Whether the array membership
test itself uses an index is a storage/provider capability, which planning and
diagnostics should expose rather than assuming it is efficient everywhere. Zero's
[join-flipping explanation](https://zero.rocicorp.dev/docs/release-notes/1.7)
motivates this choice of driving side. Its local planner/FlippedJoin source also
handles batched key lookups and distinguishes positive existence from negative
existence. We should not flip anti-joins or push a limit through a permission test
without proving equivalence.

On owned SQL storage, lower to parameterized joins/semijoins and let the database
choose execution order. On memory/IndexedDB or adapter sources without relational
pushdown, choose a selective start, batch correlation keys into indexed IN loads,
deduplicate grant identities, and recheck residual conditions. Keep logical bag
semantics for ordinary joins; authorization membership itself is set-like.

Filtering by policy happens before caller ordering/pagination, including every
child's window. Never fetch a page of raw rows and then filter that page, or fetch
one global child limit and split it among parents. Unsupported provider predicates
require safe superset loading and complete residual evaluation; an incomplete
page cannot be declared a complete authorized answer. Enforce work/result budgets
and fail explicitly when completeness cannot be established within them.

The independent evaluator uses a complete, small immutable test dataset. It
enumerates the policy graph, unions authorized cells/edges, then evaluates the
client query against that result. The optimized path rewrites the query without
first constructing the whole view. Fast-check compares both, generating duplicate
memberships, overlapping grants, missing links, multiple paths, hidden fields,
context changes, ordering/ties, offsets and per-parent limits. Mutate membership
or relationship rows and compare again; include negative authorization tests.

Offline pinning can reuse graph evaluation/materialization and dependency
collection. It is a retention policy, not a new authority. A pin must retain the
requested result and its dependencies/windows, not entire referenced object types.
Offline copies reflect last-known authorization; no protocol can retroactively
erase data already downloaded to an untrusted device. Online requests reauthorize.

## Action security scope for v0

Do include action policy checks, server-bound parameters and query-based reference/
precondition checks now: Gateway already depends on them. Reuse adminProjects to
check create/edit/delete Form actions. Creating checks the destination project;
editing/deleting checks the current stored form's project, not merely a submitted
project ID. Moving a form checks both old and new projects.

For owned execution, evaluate the guard and authoritative writes in the same
transaction/snapshot. Revalidate on apply; draft validation is not a later promise.
An action capability authorizes a trusted action implementation; it does not prove
arbitrary mutator code only edits a declaratively authorized write set. General
post-state constraints/write-set checking can follow later.

Current owned mutators receive trusted unprojected storage reads. Proposed default:
normal mutator reads use the invoking policy's authorized view. Policy/precondition
evaluation itself has an explicit trusted scope so it can inspect private permission
dependencies. An action that genuinely needs private implementation reads declares
an additional action-scoped read graph; that grant is not exposed through client
queries or inherited by other actions. Writes remain governed by the action
capability/implementation, not by assuming read permission also grants CRUD access.
Optimistic execution only has locally available permitted data; action-private
server dependencies cannot silently trigger a network read or be assumed present.

Represent this on the action rule alongside bind/check, with a small union rather
than an unrestricted privilege boolean. For example, `reads: "caller"` is the
default; `reads: { additional: actionPrivateReadDocument }` adds precisely declared
action-only reads after authorization. This is a proposed spelling, not an
implemented option. The extra read document uses entity selections and is never
returned as the caller's ordinary view.

For adapted providers, Gateway enforces the token policy it owns; Foundry/Salesforce
then enforce their own authenticated caller's permissions. A gateway precheck and
external write are not one transaction. Do not claim local query rewriting makes
checks against a separate membership store atomic with the external mutation, or
that the provider understands a token identity which exists only in Streamline.

## Fragments and data-aware documents

The referenced chats favor composable selection callbacks, recursive nested
includes, optional `.ref()` boundaries, and existing TanStack reader hooks. Keep
that direction. [Relay fragments](https://relay.dev/docs/guided-tour/rendering/fragments/)
provide the useful distinction between a reusable selection and a reference used
to read/subscribe to one particular result.

```ts
const personBadge = defineFragment(q.Person, (person) => ({
    name: person.name,
}));

const approvalCard = defineFragment(q.PostApproval, (approval) => ({
    status: approval.status,
    person: related(approval, "person").select(personBadge.select),
}));
```

Fragment composition expands hygienically into query selections and binds
arguments; it does not execute a separate request at each component. Preserve a
client read plan mapping fragment uses/result paths to stable subscription
boundaries. The server needs the expanded selection, not a React component name.
Fragments never grant access to extra fields.

Initially fragment definitions are user-space/query-construction helpers over
serializable selections, not a mandatory execution primitive in Query IR. Named
fragment definitions/spreads can later be a document encoding convenience and
expand before planning. Local fragment references, masking and React readers are
runtime concerns; preserving selection boundaries/provenance lets those develop
without embedding component objects in the portable AST.

`.select()` contributes selected values. `.ref()` can request a separately observed
result view, initially implemented using public TanStack includes if practical.
The wire IR need not force self-joins or a collection per row; that is a local
execution choice to measure. No mandatory useFragment hook: use existing readers
when the component already receives the appropriate projected collection. Add an
opaque reader only if masking/reference resolution earns it. Preserve singular
versus plural types and stable references, including under deletion.

Subscription boundaries are distinct from deferred loading. Initial v0 can load
the finite graph before readiness. A later inclusion-site defer policy and
per-boundary readiness can extend that without changing fragment selection
semantics. A data-aware HTML compiler can emit the same selection/fragment graph;
form handlers still target typed actions. UI state/event programs stay outside
read-only Query IR.

## TanStack's role

Owning Query IR does not require replacing TanStack's local IVM engine. It remains
a useful implementation for demand-driven source collections, local joins/nested
results, incremental UI subscriptions and React integration. Compile supported
portable queries into it while keeping SQL/backend execution independent of it.
Existing `.objects` collections and direct TanStack hooks can remain available.

An ontology-native query/fragment reader can later own typed references, scoped
cleanup, readiness and errors while delegating local execution to TanStack. That
would make it an implementation detail for users of that API, without requiring
an immediate migration or a second competing UI engine. The core result/query
contract must not depend on Collection instances. Explicitly reject or separately
lower unsupported features rather than claiming every IR construct already maps
to the installed TanStack release.

## Delivery strategy and query execution are separate choices

Native servers now expose `deliveryStrategy: "auto" | "snapshot" | "incremental"`.
Auto preserves capability selection. Snapshot disables selected streams and journal
delivery on that endpoint, while keeping subset invalidation hints and finite
reads. Incremental requires native selected delivery and fails the handshake when
unavailable. Both HTTP and worker server bindings use this setting. Replica clients
follow the advertised capabilities. `startSync: false` disables automatic sync;
it is not an invalidate/snapshot strategy setting.

Retain snapshot mode as production code and an independent correctness baseline.
Maintenance remains future work. Conceptually distinguish two axes rather than
presenting IVM and incremental transport as mutually exclusive:

| Axis            | Choices                                  | Meaning                                      |
| --------------- | ---------------------------------------- | -------------------------------------------- |
| Delivery        | auto / invalidate+snapshot / incremental | How selected state reaches the child         |
| Query execution | auto / recompute / IVM                   | How the server maintains the selected result |

Current native delivery is recompute + diff + incremental transmission. A future
IVM executor can emit the same incremental batches. A recompute executor can also
send snapshots. Reusing the installer preserves atomicity and outbox settlement.

Snapshot/invalidation avoids per-client comparison baselines but reloads selected
results. Recompute/diff retains bounded baselines and still reevaluates selections;
it saves unchanged payload bytes. IVM retains operator/dependency state to reduce
reevaluation work; state can be storage-backed rather than assuming it all lives
in memory. Actual cost depends on result size, update frequency and sharing; no
strategy is universally cheaper. Ordinary replica base/outbox/GC state is required
independently of these choices.

A requested delivery strategy must preserve the endpoint's authorization
guarantees. Do not expose a maintenance/IVM flag before its implementation exists.

All four non-auto combinations are meaningful:

| Maintenance | Delivery    | Use                                                             |
| ----------- | ----------- | --------------------------------------------------------------- |
| Recompute   | Snapshot    | Low retained query state; simple finite refreshes               |
| Recompute   | Incremental | Current native selection diffing; fewer repeated bytes          |
| IVM         | Snapshot    | Maintain/share a result incrementally, but deliver replacements |
| IVM         | Incremental | Incremental result maintenance and transmission                 |

IVM + snapshot still requires a scoped maintained result, potentially shared in a
cache; it does not make a stateless request handler magically retain IVM state.
Neither IVM combination is implemented yet. Strategies are deployment/connection
settings, not semantic ontology policy. The shipped deliveryStrategy option sits
alongside existing capacity/byte/acknowledgment budgets. The server controls the
strategy; future client preferences can negotiate a supported strategy without
forcing the server to acquire unoffered maintenance state or bypass authorization.

## First implementation slice

1. Add/query-validate multi-root documents, bindings, common operators,
   correlations, related lowering, guarded selections/cardinality/windows, and
   serializable policy check/bind definitions in ontology-spec. Review concrete
   serialized examples alongside proposed builder syntax before finalizing it.
2. Implement the finite reference evaluator plus read-grant/cell semantics and
   generated tests. Use the project-admin and token scenarios as acceptance fixtures.
3. Add authorized rewriting and storage/provider lowering; compare with the oracle.
   Keep one trusted context and explicit policy version per projected binding.
4. Wire finite Describe/query/action parameter/reference/attachment operations to
   that binding, preserving form/revision/token isolation and existing error policy.
   Exercise Gateway parity, then remove legacy HTTP APIs.
5. Add minimal fragment selection composition and TanStack lowering where it proves
   the query interface. Full masking, progressive loading and a new UI language are
   not prerequisites for closing Gateway parity.

The current incremental record applier can carry changed source entities later.
Live full queries additionally need result membership/identity, projected-cell
availability, hidden policy dependencies and permission-change removals. Current
finite authorization does not automatically make speculative state safe for
untrusted children; that remains the separate deferred protocol project.

## Research sources

- Local Streamline files listed above; no Streamline source edits or production
  schema assumptions. Post Approval/Person/Bid fields and Project.adminUserIds here
  are representative domain examples, not generated definitions we inspected.
- [Explore data-aware HTML](thread://01a152fb-546c-79f1-be31-29db5bd15198?hostId=local):
  ontology-aware forms/lists, composed data requirements, separate local state,
  loading/error boundaries and eventual platform renderers.
- [Design Relay-style TanStack DB Frags](thread://01a0891b-7c13-7681-a96d-49650097144e?hostId=local):
  selection composition, nested collection subscriptions, `.select`/`.ref`,
  singleton cardinality, optional materialization and no dependency patches.
- [Zero join flipping](https://zero.rocicorp.dev/docs/release-notes/1.7);
  local `rocicorp-mono` commit `84d3928edb1dc6ffeb11eaa9d51bcfa054e42a1f`,
  `zql/src/planner/planner-join.ts`, `planner-builder.ts`, `ivm/flipped-join.ts`,
  and `zero-protocol/src/ast.ts`. Logical existence/correlation is distinct from
  which side physically drives the join.
- [Zero queries](https://zero.rocicorp.dev/docs/queries): current server query
  construction can add authorization restrictions. The older RLS API is deprecated;
  this proposal does not copy it as our public policy interface.
- [Foundry object/property policies](https://www.palantir.com/docs/foundry/object-permissioning/object-security-policies/):
  object permission plus an additional property check, with separate concerns for
  downstream outputs.
- [Relay composition](https://relay.dev/blog/2023/10/24/how-relay-enables-optimal-data-fetching/):
  colocated fragment requirements compose into a root query while permitting
  component-level reads/subscriptions.
