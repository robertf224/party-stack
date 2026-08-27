# Ontology lenses

## BLUF

Add a small reusable lens language for transforming one object schema into
another. A lens is only an ordered list of operations; source and target object
types are supplied by the configuration/binding that uses it.

V0 supports only `move` and `select`. From those operations Party Stack can
derive target IR, project source rows, and rewrite target query paths into
source query paths. Additional operations, reverse writes, migrations, and
interfaces remain future work.

## Background

The Foundry adapter has a fixed native `FoundryUser` schema and needs to expose
an app-facing `User` collection:

```text
app User
    <- FoundryUser source
```

When the schemas differ, one description should drive:

- target ObjectType IR derivation;
- runtime row projection;
- query/subset path rewriting;
- later reverse patch translation.

An opaque row callback plus separate query rewrite duplicates the mapping and
can drift.

[Project Cambria](https://www.inkandswitch.com/cambria/) demonstrates lenses as
ordered schema/value/patch operations. Its operations are themselves
source/target agnostic
([`lens-ops.ts`](https://github.com/inkandswitch/cambria-project/blob/da8961440cac7eba1c3113488f5bcbc26046620f/src/lens-ops.ts#L31)).

Party Stack should follow that property: callers select endpoints; lenses only
describe transformation steps.

## Proposal

### Lens definition

```ts
interface Lens {
    operations: LensOp[];
}

type LensOp =
    | {
          kind: "move";
          /** Full source property path. */
          from: string[];
          /** Full target property path. */
          to: string[];
      }
    | {
          kind: "select";
          properties: string[];
      };

```

`move` handles both renaming and relocation. A rename is a move whose source
and target have the same parent path.

These are part of the self-hosted ontology schema in
[`ir/schema.ts`](../../packages/ontology/src/ir/schema.ts), so generated IR
types/builders include:

```ts
o.LensOp.move({
    from: ["address", "zip"],
    to: ["postalCode"],
});

o.LensOp.select({
    properties: [
        "id",
        "givenName",
        "familyName",
        "email",
        "avatar",
    ],
});
```

Definition:

```ts
const foundryUserToUser = {
    operations: [
        o.LensOp.move({
            from: ["profilePicture"],
            to: ["avatar"],
        }),
        o.LensOp.select({
            properties: [
                "id",
                "givenName",
                "familyName",
                "email",
                "avatar",
            ],
        }),
    ],
} satisfies Lens;
```

No source, target, provider, or object type names are stored in the lens.

Lens validation checks operation syntax. Source/target schema compatibility is
checked when a configuration, interface implementation, or migration embeds
the lens.

### Caller supplies endpoints

```ts
defineFoundryUsers({
    objectType: "User",
    lens: foundryUserToUser,
});
```

During Foundry pull/runtime setup:

- target `User` is named by the Foundry Users configuration;
- source `FoundryUser` is fixed by the Foundry adapter;
- the lens executes from source → target.

The same lens may be reused by another binding when the source schema is
compatible.

Later interface implementations or migration definitions embed a `Lens` value.
Reusable lenses are ordinary imported constants; no registry is required.

### Schema derivation

The compiler starts with the source `ObjectTypeDef` and applies steps in order.

Example source:

```ts
FoundryUser {
    id: string;
    givenName?: string;
    familyName?: string;
    email?: string;
    profilePicture?: attachment;
}
```

Steps:

```ts
[
    o.LensOp.move({
        from: ["profilePicture"],
        to: ["avatar"],
    }),
    o.LensOp.select({
        properties: [
            "id",
            "givenName",
            "familyName",
            "email",
            "avatar",
        ],
    }),
]
```

Derived target:

```ts
User {
    id: string;
    givenName?: string;
    familyName?: string;
    email?: string;
    avatar?: attachment;
}
```

Schema behavior:

- selected property types/optionality/constraints are retained;
- moved property metadata is retained except for name/display name;
- primary key must remain selected;
- target object name comes from the binding target;
- target display/plural names may default from the target name or be supplied
  as binding metadata.

If the target object already exists in app IR, the derived schema is validated
against it rather than appended.

### Runtime row projection

The lens compiler produces a TanStack select projection:

```ts
q.from({ source: foundryUsers })
    .select(({ source }) => ({
        id: source.id,
        givenName: source.givenName,
        familyName: source.familyName,
        email: source.email,
        avatar: source.profilePicture,
    }));
```

The projection is declarative query IR, not an opaque JavaScript mapper.

### Query path rewriting

The compiler also records target → source paths:

```text
User.id          -> FoundryUser.id
User.givenName   -> FoundryUser.givenName
User.familyName  -> FoundryUser.familyName
User.email       -> FoundryUser.email
User.avatar      -> FoundryUser.profilePicture
```

When the bound target collection receives `loadSubset`:

```text
where User.id == "123"
    -> where FoundryUser.id == "123"
    -> source loadSubset
    -> Foundry Users.getBatch
```

```text
orderBy User.familyName
    -> orderBy FoundryUser.familyName
```

Filters/order/cursors referring to unselected target properties fail
validation.

### Bound on-demand collection

The composite backend exposes the app target normally:

```ts
ontology.objects.User
```

Internally:

```text
target User query/loadSubset
    -> rewrite target paths through lens
    -> source FoundryUser loadSubset
    -> source rows/deltas
    -> lens projection
    -> target User rows/deltas
```

The target must not be implemented as an eager materialized collection followed
by another query; downstream target filters need to narrow source loading.

The bound collection propagates source inserts, updates, deletes, errors, and
cleanup after applying the lens.

### Keys

V0 requires:

- source primary key remains selected;
- source/target primary-key type is unchanged;
- primary key may be moved to another top-level name but not nested/computed;
- resulting key mapping is injective.

This makes delete/update delta routing deterministic.

### Foundry users

The Foundry adapter publishes the native `FoundryUser` IR and collection. The
app configuration needs only:

```ts
users: {
    objectType: "User",
    lens: foundryUserToUser,
}
```

Foundry pull applies the lens to derive/add User IR, rewrites user-formatted
properties/action parameters to `objectReference("User")`, and types
`context.user`.

Runtime uses the same lens for row projection and subset query rewriting.

Issue-tracker UI derives display names/initials from givenName/familyName with
ID fallback. Computed schema fields such as `displayName` wait for
expression-based lens steps.

### Validation

Reject:

- unknown source paths;
- duplicate target paths;
- selecting missing properties;
- omitting the primary key;
- incompatible pre-existing target schema;
- non-injective primary-key mapping;
- moving a property into its own descendant;
- empty/invalid paths.

## Testing

Schema:

- Move/select derives expected target ObjectTypeDef.
- Source types, optionality, and constraints are preserved.
- Existing target schema compatibility validates.
- Primary-key removal/change fails.

Values:

- Source rows project to target rows.
- Missing optional fields remain missing.
- Unknown/unselected fields do not leak.

Queries:

- ID equality/`in` rewrites to source paths.
- Move rewrites where/order/cursor paths.
- Unselected paths fail.
- Target subset loading does not eagerly load all source rows.

Collections:

- Source insert/update/delete produces target deltas.
- Source errors/cleanup propagate.
- Target keys remain stable.

## Rollout

1. Add `Lens` and `LensOp` to the self-hosted IR schema.
2. Add generated builders/codecs/validation.
3. Add schema transformation/validation.
4. Add runtime query projection compiler.
5. Add target → source path rewrite map.
6. Add custom on-demand bound object collection.
7. Integrate lenses into Foundry Users pull/runtime configuration.
8. Ship FoundryUser → app User vertical slice.

## Open questions

1. Are property paths string arrays or generated typed builders?
2. Is select explicit, or inferred from a pre-existing target schema?
3. Where do target display/plural names live when the lens derives target IR?
4. How does a source advertise unsupported order/cursor pushdown?

## Alternatives considered

### Lens includes source/target

Reduces reuse and mixes transformation with deployment binding. Endpoints belong
to the binding.

### TanStack projection callback only

Projects rows but cannot independently derive target IR or guarantee consistent
query path rewriting.

### Handwritten row mapping and subset rewrite

Duplicates mappings and can drift.

### More operations in V0

Add/remove/compute are valuable but unnecessary for the first User
vertical slice.

## Future work

- Add/remove structural operations.
- Deterministic expression-based computed fields.
- Reverse target-patch → source-patch translation.
- Versioned schema migration graphs.
- First-class interfaces with multiple implementation lenses and tagged refs.
- Link traversal through joins/includes.
