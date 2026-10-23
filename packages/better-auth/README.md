# Better Auth integration

The root export supplies the multi-session `partyStack`/`partyStackClient` plugins
and the scoped connection adapter. `/storage` supplies a Better Auth database
adapter over an owned ontology backend's trusted storage capability.

## Application-owned models and lenses

Author your ontology normally. Better Auth's expected schema is a compatibility
contract, not the canonical schema of your application. For example, your `Person`
can use `personId`, `displayName`, and `emailAddress` while Better Auth sees `id`,
`name`, and `email`.

```ts
import { makeBetterAuthStorage } from "@party-stack/better-auth/storage";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { betterAuth } from "better-auth";
import { Effect } from "effect";

// Run inside the application's Effect Scope; tables and ir are supplied by it.
const openAuth = Effect.fn("App.openAuth")(function* () {
    const backend = yield* makeOwnedBackend({
        namespace: "auth",
        ir,
        tables,
        mutators: {},
    });
    const database = yield* makeBetterAuthStorage({
        storage: backend.storage,
        models: {
            user: {
                objectType: "Person",
                lens: {
                    operations: [
                        o.LensOp.move({ from: ["personId"], to: ["id"] }),
                        o.LensOp.move({ from: ["displayName"], to: ["name"] }),
                        o.LensOp.move({ from: ["emailAddress"], to: ["email"] }),
                    ],
                },
            },
            session: { objectType: "Session", lens: sessionLens },
            account: { objectType: "LoginMethod", lens: accountLens },
            verification: { objectType: "Verification", lens: verificationLens },
        },
    });
    return betterAuth({ database, ...authOptions });
});
```

The schematic example assumes each view exposes all configured auth fields,
including timestamps and optional fields. The complete runnable composition and
its authored definitions are in
[issue-tracker auth](../../apps/issue-tracker/src/server/auth.ts) and
[server ontology](../../apps/issue-tracker/src/server/ontology.ts).

Models are keyed by Better Auth's logical names, including plugin models. Better
Auth's own model/field aliases are handled separately by its adapter factory.
Missing fields, incompatible field types, and an id that is not a string primary
key are rejected. The initial lenses support move/select, including moving nested
struct properties. Computed fields, casts, split/merged models, and encrypted auth
storage are not implemented by this adapter.

Reads project source objects through the lens. Filters, ordering, and indexes
rewrite their paths back to source properties. Writes merge into the existing
source object, preserving fields excluded from the auth view. `defaults` on a
model supplies source-side application values on creation; ontology validation
still checks the whole resulting object. Dates cross the Better Auth boundary as
JavaScript Date and are stored as Temporal.Instant. Optional null clears become
undefined. JSON values are validated as JSON, rather than accepting arbitrary
JavaScript objects. Named ontology types and scalar object references are supported.

## Transactions and replication

`backend.storage` is a supported **trusted integration capability**. Ordinary
application code should use ontology actions. This capability lets an existing
server-side library keep its own execution logic while storing ontology objects;
it is not another public RPC endpoint or a replacement for action authorization.
It bypasses action dispatch, invocation receipts, and action-specific checks.

Its read and transaction callbacks use object type names and the same read/put/
delete interface as owned mutators; write callbacks additionally support
`ensureIndex`. Writes pass through ontology validation and attachment retention.
Object changes and one journal batch commit in the same native transaction, then
subscribers receive a wake-up hint. Multiple writes to a row coalesce to its final
change. A failed callback or journal append rolls everything back. Index-only
transactions do not add change batches. Integration commits have no invocation ID
or action receipt; native transaction success determines their outcome.

Better Auth's callback transaction binds all its adapter operations to that one
transaction, including parallel awaited operations. `consumeOne` and guarded
`incrementOne` run atomically. Nested transactions are unsupported, and transaction
handles must not escape their callback. Scope closure interrupts owned operations
and rejects subsequent SDK calls. The entire HTTP request is not automatically
one transaction; Better Auth chooses where to use its transaction API.

Declared unique fields, references, expiry dates, and table-index constituents get
indexes. Composite uniqueness and reference actions are enforced transactionally
by the adapter. Direct source writes outside this adapter do not automatically
acquire Better Auth-specific constraints. Query predicates/order/pagination use
native subset execution where supported. Literal `%`/`_` in string searches and
whole JSON/array absence checks use an exact residual check before pagination.
`count` currently materializes matching rows because storage has no count aggregate.

The journal contains the actual source rows. Keep credentials, password hashes,
sessions, verification tokens, and their journal private. A future dashboard can
replicate an authorized Person projection, but this integration does not itself
implement field/row authorization for that projection. The example exposes a profile-only backend view of its shared server ontology,
projecting snapshots and journal changes before full-view replication is granted.

## Migrations and Effect hosting

Better Auth is configured with a custom database adapter. Do not call its Kysely
migration runner against this adapter. Existing ontology definition guards remain
in force; this checkpoint adds no migration executor or automatic schema changes.
Upgrade the authored definitions/lenses and migrate data explicitly once that
mechanism exists. The example uses a new shared native namespace for auth and issue data and seeds its demo
users; it does not import existing Better Auth SQL tables or preserve their sessions.

Better Auth's official Effect HTTP integration mounts the standard `auth.handler`
in an Effect HTTP router. The database adapter already uses Effect internally;
Promise methods are the SDK boundary. No beta Better Auth upgrade or additional
HTTP wrapper is required for this integration.

Alchemy's Better Auth integration can take a custom adapter factory through its
`Database` service's `runtime` effect. That effect should acquire the tables,
owned backend, and scoped adapter inside the execution Scope; return the factory
as the database input. Omit its `migrate` capability and use `migrate: false` when
explicitly configuring the BetterAuth resource. Acquire Worker database/network
resources per execution as Alchemy requires. No Alchemy-specific helper or cloud
deployment is included in this package checkpoint.

References:

- [Better Auth database adapters and migrations](https://better-auth.com/docs/concepts/database)
- [Custom adapter contract](https://better-auth.com/docs/guides/create-a-db-adapter)
- [Effect HTTP integration](https://better-auth.com/docs/beta/integrations/effect)
- [Alchemy Better Auth](https://alchemy.run/better-auth/)
- [Alchemy database integration](https://alchemy.run/better-auth/databases/)

## SQLite example: searchable users

The example stores Better Auth users directly as its canonical `User` objects,
alongside issues/projects and private session/login records. User collections
therefore include all registered profiles, rather than copying the current
session's profile on every request. The old `_seedAuthenticatedUser` action and
per-request profile-copy code are removed. Better Auth uses its lens over that
same User row, preserving profile properties such as the attachment avatar.

The example's `public-backend.ts` applies a schema-driven select lens to snapshots
and journal entries, hides private object types, and rejects queries referencing
private top-level fields. This is a demo-wide public profile view, not a general
row-level authorization implementation. Session/credential types are not exposed.
