# @party-stack/ontology-spec

Relationship traversal uses `o.Expression.related({ source, link })`. Static
validation derives an object for a to-one direction and an object list for a
to-many direction; `map` bindings retain the target object type. Execution support
is context-specific: the current action evaluator supports to-one traversal only.

The complete descriptive model for Party Stack ontologies, shared by live clients,
owned storage implementations, remote adapters, and tooling. Attachments, object
references, links, actions, and query functions remain first-class ontology types.
This is an extraction of the existing ontology model, not another generic schema
language below it.

```ts
import { defineOntology, o, type ObjectTypeDef } from "@party-stack/ontology-spec";
import { encode, decode } from "@party-stack/ontology-spec/json";
```

The main entry exports IR types/builders, inference helpers, structural IR
validation, lenses, `OntologyDefinition`, `OntologyObject`, and shared validation
results. It does not import TanStack collections, live runtimes, Node APIs, or
code generation. Dates remain `Temporal.PlainDate`; timestamps remain
`Temporal.Instant`. `ObjectTypeDef` and related definitions retain their existing
meaning; no new storage schema or migration API is introduced by the extraction.

| Entry             | Contents                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| `.`               | Ontology types/builders, inference, validation, and lenses                     |
| `/values`         | Type-only value primitives, including Temporal and attachment handles          |
| `/utils`          | Pure type/path/link/target helpers                                             |
| `/query`          | Structural query types and pure low-level construction helpers                 |
| `/json`           | Existing schema-aware JSON encoding and decoding                               |
| `/effect`         | Runtime schema compiler, Temporal schemas, and portable-to-Effect Result codec |
| `/effect/values`  | Type-only value view using Effect Result                                       |
| `/schema`         | The self-describing ontology IR definition                                     |
| `/constants`      | Generated constants for the IR                                                 |
| `/meta`           | The meta-ontology definition and its generated model types                     |
| `/meta/constants` | Generated meta-ontology constants                                              |
| `/examples/blog`  | Pure example ontology used by validation and live examples                     |
| `/generate`       | Build-time generators, formatting, and file generation                         |

The query grammar describes multi-root selections, correlated subqueries,
conditional fields, ordering and pagination. A `Query` extends the named `Subset`
definition's `where`, `orderBy` and `page` fields with `from` and `select`; there is
no nested `subset` wrapper. Both schemas reuse the same field definitions.
Expressions use top-level operator tags, including `case` and `exists`;
selections use `field`, `sub` and recursively branching `selectCase`. Flat joins
are deferred. Query execution, semantic validation and
authorization are still being implemented; these constructors alone do not enforce
permissions. The `/query` entry does not require Effect.

## Code generation and bootstrap

Codegen stays in this package for now. Generator imports are isolated under
`/generate`, although installing the package also installs its tooling dependencies.
The standalone `ontology-spec` CLI generates models without depending on the live
`ontology` package. The existing `ontology` CLI continues to support generation
and live metadata pulling.

```sh
pnpm --filter @party-stack/ontology-spec bootstrap
pnpm --filter @party-stack/ontology-spec generate:meta
```

The IR definition and checked-in generated builders/types bootstrap each other,
as before. Bootstrap is an explicit development command, not an automatic build
prerequisite or a dependency back into the live runtime. The meta generation
command emits types/constants with `--no-live`; its live factory stays in
`@party-stack/ontology`.

For an application or a storage-only model:

```sh
ontology-spec generate --ontology ./ontology.ts --outDir ./generated --namespace App --no-live
```

Omit `--no-live` to also emit a factory importing `@party-stack/ontology` in the
consumer's generated output. The generator itself does not import that runtime.
Generated model value types reference `@party-stack/ontology-spec/values`.
The legacy `ontology generate` command retains its existing value import path
for compatibility.

Programmatic `generateFiles` additionally accepts `emitLive`, `valuesImportPath`,
and `runtimeImportPath`. This supports bootstrap and runtime wrappers without
hard-coding a dependency from the spec package back to the runtime.

## Derived Effect schemas

For definitions loaded at runtime, build the same codec registries directly:

```ts
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";

const { objectSchemas, actionParameterSchemas } = compileEffectSchemas(ir);
```

This constructs Effect schemas without code generation or evaluating source text.
It captures the supplied definitions, supports recursive references, and throws
for invalid codec definitions during setup. It expects ontology IR, rather than
parsing an untrusted JSON document. Runtime-created registries have dynamic names
and value types; generated codecs additionally expose named static model types.
The runtime and generated codecs are tested against the same representative
values and the complete self-describing ontology, including JSON conversions.

Install Effect v4 when using this optional feature, then generate from the same IR:

```sh
ontology-spec generate --ontology ./ontology.ts --outDir ./generated --namespace App --no-live --effect
```

Both `ontology-spec generate` and the legacy `ontology generate` accept `--effect`.
The default output stays unchanged. The flag adds:

- `effect-types.ts`: the same models, with `result` represented by Effect's `Result.Result<A, E>`.
- `effect.ts`: named codecs such as `UserSchema`, plus `namedSchemas`, `objectSchemas`,
  `actionParameterSchemas`, `queryParameterSchemas`, and `queryReturnSchemas` registries.

`effect.ts` also re-exports the Effect model types, so consumers can import
`{ UserSchema, type User }` from one module or infer `typeof UserSchema.Type`.
The separate generated declarations provide type anchors for recursive schemas;
they are not a second authored model. The ontology definition and portable result
shape remain language-neutral, allowing future generators to map results to
another language's representation, such as Rust's `Result<T, E>`.

Each codec has the shape `Schema.Codec<EffectModel, CoreModel>`. Decoding converts
portable ontology values into the Effect view; encoding goes back to the core
view. Result values use Effect's constructors and helpers in memory, while their
portable shape stays `{ kind: "ok" | "err", value }`. Nested results compose the
same way. Models remain plain objects; no Schema classes or separate authored
schemas are required. Optional fields remain optional fields, not Effect Option.
Temporal remains Temporal in both in-memory views.

```ts
import { Result, Schema } from "effect";
import { JobSchema } from "./generated/effect.js";

// Assuming Job has a result field named outcome:
const job = Schema.decodeUnknownSync(JobSchema)({
    id: "job-1",
    outcome: { kind: "ok", value: "done" },
});
Result.match(job.outcome, { onSuccess: console.log, onFailure: console.error });
const portable = Schema.encodeSync(JobSchema)(job);

// Validate values that are already in the Effect view:
const validateJob = Schema.decodeUnknownEffect(Schema.toType(JobSchema));

// JSON codecs also encode Temporal as ISO strings and decode it back:
const json = Schema.toCodecJson(JobSchema);
const jsonText = Schema.fromJsonString(json);
const encodeJson = Schema.encodeEffect(jsonText);
const decodeJson = Schema.decodeUnknownEffect(jsonText);
```

The Effect-returning parser APIs retain `SchemaError` in the error channel;
`decodeUnknownSync` is useful for synchronous boundaries but throws on failure.
Use `Schema.toType(codec)` to validate existing Effect values, and `codec` itself
to decode the portable representation. `Schema.toCodecJson(codec)` composes the
portable conversion with canonical JSON encoding, including nested Temporal
values and nanosecond-precision timestamps. Temporal schemas use this package's
`temporal-polyfill` instances, matching existing ontology value types.

Generated codecs cover all current TypeDef kinds, including recursive named
models, tagged unions/results, string-key records, enum/regex constraints,
attachments, and object references. Integers validate as signed 32-bit numbers;
float/double values must be finite JS numbers (no float32 rounding is performed).
Attachment schemas validate handle shape and declared media types, not byte size,
image dimensions, or authorization. References validate the target primary-key
value, not target existence. Action defaults may be omitted but are evaluated by
the action runtime; optional action inputs retain their existing null semantics.
Context validation and operation execution are outside these generated codecs.

These are opt-in boundaries. Existing `/json` helpers keep their current behavior,
including their permissive decoding and optional-null normalization; they are not
replaced. New Effect codecs use Effect's normal parser options (for example,
unknown struct keys are stripped by default). `unknown` remains opaque in memory;
deriving a JSON codec does not promise arbitrary opaque values are serializable.
No bigint ontology kind is added: a future `long` type can define that explicitly.

When publishing generated models as a package, expose `./effect` by mapping that
export to `generated/effect.js` (and its declaration file). The supporting types
need no separate public package export.

Programmatic codegen exports `generateEffectSchemas`; `generateFiles` accepts
`emitEffectSchemas: true` to emit both additional files. Effect is an optional peer,
and ordinary spec entry points and codegen do not load the Effect runtime.

## Compatibility and next steps

`@party-stack/ontology`, `/utils`, `/values`, and `/json` retain their public spec
exports through this package. Existing live installations, backends, actions,
attachments, and generated live factories remain in `ontology`.

Richer lenses/casts, migration history, and the future pull/action/receipt backend
protocol can build on these definitions. This checkpoint does not change storage
layouts, action transaction semantics, or the backend adapter contract.
