import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import * as Memory from "../../packages/ontology-storage/src/memory/tables.js";
import {
    overlay,
    loadVisible,
    putVisible,
    deleteVisible,
} from "../../packages/ontology-storage/src/overlay/index.js";
import { selectPlan } from "../../packages/ontology-storage/src/planner/plan.js";
import {
    Tables,
    Table,
    field,
    eq,
    lt,
    inArray,
    ilike,
    like,
    and,
    cursorOf,
    type Query,
    type Row,
} from "../../packages/ontology-storage/src/table-api.js";
import { compileQuery } from "../../packages/sql-ontology-storage/src/compiler.js";

type Chapter = {
    title: string;
    concept: string;
    design: string;
    audit: string;
    limits: string;
    files: string[];
    docs?: [string, string][];
    code: string;
};
const core = "packages/ontology-storage/src/";
const doc = (path: string) => `https://effect.website/docs/v4/${path}`;
const chapters: Chapter[] = [
    {
        title: "Scope and package boundaries",
        concept:
            "Tables is the storage substrate for a future Replica. One service provides keyed records, atomic transactions, declared indexes, and subset reads. There are no subscriptions or replication protocol in this checkpoint.",
        design: "Core owns semantics. Separate IndexedDB and SQL packages own resources and physical storage. Optional /memory, /planner, /overlay, /testing, and /driver exports keep unrelated implementations out of the main entry point. /driver is an intentional adapter authoring contract, replacing the misleading /internal name.",
        audit: "Are these primitives sufficient for the future base, outbox, overrides, and revision metadata? Are we promising anything replication-specific too early?",
        limits: "The existing TanStack IndexedDB persistence adapter remains unchanged. Its integration, SharedWorker RPC, full migrations, and Replica are follow-up work.",
        files: [
            "packages/ontology-storage/package.json",
            core + "index.ts",
            core + "driver/index.ts",
            "specs/2026-10-19-effect-tables-replica/README.md",
        ],
        code: `import { Tables, Table } from "@party-stack/ontology-storage/tables";\nimport * as Memory from "@party-stack/ontology-storage/memory/tables";\nimport * as IndexedDbTables from "@party-stack/indexeddb-ontology-storage/tables";\nimport * as SqlTables from "@party-stack/sql-ontology-storage/tables";`,
    },
    {
        title: "Effect, services, and layers",
        concept:
            "Effect<A, E, R> describes a program: A is its result, E its expected failures, and R the services it needs. Creating an Effect does not run it. yield* sequences programs inside Effect.gen.",
        design: "Tables is a Context.Service key plus a TypeScript service interface. A Layer constructs and provides one implementation. Programs request Tables; the application chooses a backend. Library hot paths use Effect.fnUntraced, following the installed v4 guide. Named Effect.fn is useful at application tracing boundaries.",
        audit: "Does application code depend on Tables rather than constructing a backend per operation? Is the same service retained for related calls?",
        limits: "Memory state belongs to one service instance. Repeated runPromise calls each providing a newly built Memory.layer produce independent databases. Retain a runtime for an application lifetime.",
        files: [core + "tables.ts", core + "memory/tables.ts", core + "errors.ts"],
        docs: [
            ["Services", doc("requirements-management/services")],
            ["Layers", doc("requirements-management/layers")],
            ["Layer memoization", doc("requirements-management/layer-memoization")],
        ],
        code: `const tasks = Table.make<{ title: string }>({ name: "tasks" });\nconst program = Effect.gen(function* () {\n    const tables = yield* Tables;\n    yield* tables.put(tasks, "a", { title: "Learn Effect" });\n    return yield* tables.get(tasks, "a");\n});\nawait Effect.runPromise(program.pipe(Effect.provide(Memory.layer)));`,
    },
    {
        title: "Tables, keys, and rich values",
        concept:
            "A Table<A> is a descriptor: logical name, version, encoder, and decoder. A row is { key, value }; keys are strings or finite numbers. A generic type parameter provides compile-time information, not runtime validation.",
        design: "A tagged tree supports nested objects/arrays, bigint, Date, undefined, Temporal.Instant/PlainDate, Map, and Set. Effect Schema.fromJsonString handles JSON encoding/decoding and validates the storage protocol. App codecs are optional; no reference graph or Atom format remains.",
        audit: "Which domain classes require a codec? Where should untrusted application input be validated? Is the table version changed when a representation changes?",
        limits: "Cycles, buffers/views, RegExp, non-finite numbers, invalid dates, symbols, functions, and other Temporal kinds are unsupported by the default codec. Shared references become independent copies. The new format rejects the unreleased graph prototype. Version mismatch is a guard, not a migration runner.",
        files: [
            core + "model.ts",
            core + "storage/values.ts",
            core + "storage/values.test.ts",
            core + "storage/schema.ts",
        ],
        docs: [["Schema basics", doc("schema/basic-usage")]],
        code: `const invoices = Table.make<{ total: bigint; due: Temporal.PlainDate }>({\n    name: "invoices", version: 1\n});\nyield* tables.put(invoices, 1, {\n    total: 9007199254740993n,\n    due: Temporal.PlainDate.from("2026-10-19")\n});\n// Optional codec: { encode(domain): unknown, decode(value): Domain }`,
    },
    {
        title: "Explicit references and predicates",
        concept:
            "field('address', 'city') creates { _tag: 'Field', path: ['address', 'city'] }. Scalars are literal operands in every position. A reference is never inferred from a string or argument position.",
        design: "eq/ne/lt/lte/gt/gte accept operands on both sides: field–literal, literal–field, field–field, or literal–literal. IN takes a left operand and literal scalar list. LIKE/ILIKE accept a reference or string pattern. AND/OR/NOT compose a plain AST that adapters can generate programmatically.",
        audit: "Does eq('status', 'active') clearly mean a constant comparison? Do we want a typed proxy convenience later, producing this same AST?",
        limits: "No arbitrary callbacks, joins, computed expressions, or raw SQL. No prefix predicate: use LIKE 'abc%'. Wildcards are % and _, with no escape syntax. Dot-containing property names remain distinct from nested paths.",
        files: [
            core + "model.ts",
            core + "query/schema.ts",
            core + "query/evaluate.ts",
            core + "query/query.test.ts",
        ],
        code: `and(\n    eq("open", field("status")),\n    lt(field("spent"), field("budget")),\n    or(inArray(field("team"), [1, 2]), ilike(field("title"), "urgent%"))\n)\n// Literal key vs nested path:\nfield("address.city")\nfield("address", "city")`,
    },
    {
        title: "Ordering, pagination, and scalar semantics",
        concept:
            "Indexes and evaluators share a total scalar order: undefined, null, boolean, finite number, bigint, valid Date, string, Temporal.Instant, Temporal.PlainDate. Strings compare UTF-16 units; instants compare nanoseconds.",
        design: "Queries support multi-field asc/desc ordering, offset/limit, and exclusive cursors with every sort value plus a row key. Row keys break ties ascending, even when fields sort descending. Missing fields resolve to undefined, and comparisons use explicit two-valued semantics rather than SQL NULL semantics.",
        audit: "Are tie ordering and cursor boundaries consistent across all three backends? Does a filtered page still return the correct limit when residual evaluation is required?",
        limits: "Cursor pagination is deterministic within a snapshot. Separate transactions do not guarantee a stable dataset during concurrent writes. Objects, NaN/infinity, and invalid dates can be persisted but cannot be compared or indexed as scalars.",
        files: [
            core + "query/evaluate.ts",
            core + "planner/index.ts",
            "packages/sql-ontology-storage/src/compiler.ts",
            core + "testing/index.ts",
        ],
        code: `const query = {\n    where: ilike(field("title"), "task%"),\n    orderBy: [{ field: field("rank"), direction: "desc" as const }],\n    limit: 2\n};\nconst page = yield* tables.loadSubset(tasks, query);\nconst next = yield* tables.loadSubset(tasks, {\n    ...query, after: cursorOf(page.at(-1)!, query)\n});`,
    },
    {
        title: "Atomic transactions and Effect context",
        concept:
            "withTransaction(effect) establishes an atomic boundary. Ordinary calls on that service reuse its transaction through Effect context; withReadTransaction does the same for reads. transaction(tx => effect) and read(tx => effect) expose explicit handles too.",
        design: "Cross-table operations commit together. Expected failure, a defect, or interruption rolls back. Callback business errors remain in E. A per-transaction semaphore serializes operations, nested transaction boundaries are rejected, and handles expire on exit. Native commit completion is awaited.",
        audit: "Are all writes for one business change inside a boundary? Are non-database side effects kept outside retryable callbacks? Are spawned fibers joined before the transaction ends?",
        limits: "This is ordinary transaction isolation supplied by the backend, not distributed atomicity. No automatic retries, after-commit notifications, or cross-tab Replica revision stream yet.",
        files: [
            core + "tables.ts",
            core + "testing/index.ts",
            "packages/indexeddb-ontology-storage/src/index.ts",
            "packages/sql-ontology-storage/src/index.ts",
        ],
        docs: [
            ["Scope", doc("resource-management/scope")],
            ["Services and context", doc("requirements-management/services")],
            ["Unexpected errors", doc("error-management/unexpected-errors")],
        ],
        code: `yield* tables.withTransaction(Effect.gen(function* () {\n    yield* tables.put(tasks, "a", task);\n    yield* tables.put(metadata, "revision", 42n);\n    if (!allowed) return yield* Effect.fail("Rejected" as const);\n}));\n// Both writes commit, or both roll back.`,
    },
    {
        title: "Declared indexes and version guards",
        concept:
            "ensureIndex(table, { name, field, unique? }) declares an immutable logical index and backfills existing rows. Repeating the same declaration is idempotent; changing a definition under the same name fails.",
        design: "Writes maintain index values atomically. A lowercase companion supports ILIKE with JavaScript lowercase semantics. Unique indexes treat null/undefined as ordinary values. A reserved metadata stamp checks table versions, including tables without user indexes.",
        audit: "Should indexes be provisioned once at startup or migration time? Is uniqueness scoped to the intended logical table?",
        limits: "Backfills scan a table. Changing schemas/index semantics needs an explicit future migration or new namespace. Native SQL index key-size limits apply. The tagged-reference metadata format is part of this unreleased branch; no legacy metadata migration is provided.",
        files: [core + "tables.ts", core + "storage/schema.ts", "packages/sql-ontology-storage/src/index.ts"],
        code: `yield* tables.ensureIndex(tasks, { name: "rank", field: field("rank") });\nyield* tables.ensureIndex(tasks, {\n    name: "email", field: field("email"), unique: true\n});\n// Same name + different field/unique flag => IndexError.`,
    },
    {
        title: "IndexedDB storage and lifecycle",
        concept:
            "IndexedDB uses three fixed native stores: rows, definitions, entries. Logical indexes are ordinary entry records, so adding a table/index does not upgrade the database schema.",
        design: "Effect's browser IndexedDb service supplies the native factory. The adapter queues native requests from request callbacks and keeps a sentinel request active across Effect yields. Cancellation aborts and drains; success waits for oncomplete; blocked opens fail and versionchange closes the connection.",
        audit: "Can transactions survive Effect scheduling gaps? Does cancellation release resources? Are keepalive requests bounded and stopped on every exit path?",
        limits: "Browser persistence/quota policy still applies. Multi-tab ownership and demand synchronization are not Replica implementations. Native Chromium tests supplement fake IndexedDB conformance.",
        files: [
            "packages/indexeddb-ontology-storage/src/index.ts",
            "packages/indexeddb-ontology-storage/src/lifecycle.test.ts",
            "packages/indexeddb-ontology-storage/src/contract.browser.test.ts",
        ],
        docs: [["Resource scope", doc("resource-management/scope")]],
        code: `import * as IndexedDb from "@effect/platform-browser/IndexedDb";\nconst TablesLive = IndexedDbTables.layer({ databaseName: "app" }).pipe(\n    Layer.provide(IndexedDb.layer)\n);\n// Build once for the owning application's scope.`,
    },
    {
        title: "The optional candidate planner",
        concept:
            "IndexedDB and memory share a candidate planner. Candidate sets must contain every real match; the full predicate is always evaluated on decoded rows. SQLite/PostgreSQL use their own optimizers instead.",
        design: "Plans use native counts, selective-first AND, OR union, empty-intersection short circuits, and bounded batches. A small intersection stops scanning broad indexes. LIKE/ILIKE extract a necessary leading range. Finite single-field ordered pages use bounded scans and complete descending tie groups.",
        audit: "Does every optimization preserve the candidate-superset rule? Does OR fall back when a branch cannot be narrowed? Does a field–field comparison remain a residual unless safely compiled by SQL?",
        limits: "NOT, dynamic patterns, and unindexed expressions may scan rows. Memory uses sorted arrays with linear maintenance rather than a B-tree. The planner is an explicit subpath, not imported by the main or SQL entry points.",
        files: [
            core + "planner/plan.ts",
            core + "planner/index.ts",
            core + "memory/tables.ts",
            "packages/indexeddb-ontology-storage/src/contracts/planner.ts",
        ],
        code: `and(\n    gte(field("rank"), 0),\n    eq(42, field("category"))\n)\n// Normalize literal–field equality for lookup.\n// Count both candidates; hydrate the smaller set; evaluate both tests.`,
    },
    {
        title: "SQL projection, pushdown, and residuals",
        concept:
            "A row keeps its complete value-tree payload plus a JSON/JSONB projection of encoded scalar values for declared index fields. Native expression B-trees use json_extract in SQLite and ->> in PostgreSQL.",
        design: "Supported comparisons, IN, simple LIKE ranges, ordering, cursor conditions, and pagination compile to SQL. Indexed field–field comparisons compile too. Complex patterns and undeclared fields leave residuals. AND can push safe necessary clauses; OR/NOT cannot drop unsupported branches. No SQL limit/offset is applied before residual evaluation.",
        audit: "Do DDL expressions exactly match SELECT expressions so the optimizer uses indexes? Does a partial predicate ever paginate too early?",
        limits: "Only SQLite and PostgreSQL dialects are supported. Native driver choice is flexible within those dialects. EXPLAIN tests use SQLite and PGlite PostgreSQL; they do not prove behavior of every hosted database deployment.",
        files: [
            "packages/sql-ontology-storage/src/compiler.ts",
            "packages/sql-ontology-storage/src/index.ts",
            "packages/sql-ontology-storage/src/planner.test.ts",
        ],
        docs: [
            ["Effect SQL source", "https://github.com/Effect-TS/effect/tree/main/packages/effect/src/sql"],
        ],
        code: `const TablesLive = SqlTables.layer({ prefix: "app" }).pipe(\n    Layer.provide(SqliteClient.layer({ filename: "app.db" }))\n);\n// Or provide a PostgreSQL SqlClient layer.\n// Queries keep the same AST and portable scalar semantics.`,
    },
    {
        title: "SQL injection and the backend boundary",
        concept:
            "Data values must remain data. A query object cannot supply raw SQL, operators, identifier fragments, or arbitrary expressions. Runtime shape validation protects JavaScript/network callers as well as typed callers.",
        design: "CRUD uses Effect SQL binds; the compiler binds scalar values, cursors, limits, and offsets. AST operators/directions are whitelisted. Index projection names are hex-only. Identifiers are quoted and physical prefixes allowlisted. Partial-index table constants are escaped consistently in DDL and SELECT, using explicit PostgreSQL E strings safe under nonstandard backslash settings.",
        audit: "Can any untrusted value reach sql.unsafe/sql.literal as executable syntax? Does each native SQL call use a controlled fragment or bind?",
        limits: "SQL safety is not authorization. A backend must choose permitted table descriptors and enforce tenant/row access and query budgets. This library does not make arbitrary client queries an authorized server API.",
        files: [
            "packages/sql-ontology-storage/src/compiler.ts",
            "packages/sql-ontology-storage/src/index.ts",
            "packages/sql-ontology-storage/src/safety.test.ts",
            core + "query/schema.ts",
        ],
        code: `eq(field("title"), "x'; DROP TABLE app_rows; --")\n// The value is encoded and bound, never appended as SQL syntax.\n// Malformed op/direction/field shape => typed QueryError.\n// Hostile table/index names are covered by native DB tests.`,
    },
    {
        title: "Typed failures, reasons, and retry",
        concept:
            "OntologyStorageError is a stable boundary error with an explicit tagged reason: QueryError, CodecError, UniqueConstraint, SchemaMismatch, IndexError, TransactionError, ConfigurationError, or StorageError.",
        design: "Outer and reasons are Schema.TaggedError classes. OntologyStorageErrorReason is a schema union. catchReason selectively recovers; unwrapReason enables catchTag. error.cause is the reason; reason.cause retains an original backend/codec failure. SQL retryability comes from native Effect SQL metadata, never guessed operation text.",
        audit: "Which failures can a caller recover from? Do codec failures stay CodecError during candidate hydration? Does a caught SQL statement failure still prevent false commit success?",
        limits: "Defects and interruption remain distinct from expected failures. Tables never automatically retries a callback. Schema serialization of arbitrary native causes is diagnostic, not a promise to reconstruct every driver's custom exception class.",
        files: [
            core + "errors.ts",
            core + "errors.test.ts",
            "packages/sql-ontology-storage/src/contract.test.ts",
        ],
        docs: [
            ["Expected errors and reasons", doc("error-management/expected-errors")],
            ["Retrying", doc("error-management/retrying")],
        ],
        code: `yield* tables.put(users, key, user).pipe(\n    Effect.catchReason("OntologyStorageError", "UniqueConstraint", reason =>\n        Effect.log("Duplicate in " + reason.table + "/" + reason.index)\n    )\n);\n// Or unwrapReason("OntologyStorageError"), then catchTag("UniqueConstraint", ...).`,
    },
    {
        title: "Sparse overlays and complex visible reads",
        concept:
            "An overlay composes a base table with sparse keyed overrides. An override replaces a full row or marks its key deleted. Shadowing happens before final filtering: an override that stops matching must hide the formerly matching base row.",
        design: "loadVisible reads both sources in one transaction, overfetches a bounded base prefix by the number of overrides, removes all shadowed keys, appends nondeleted overrides, then applies the final query/order/page. putVisible/deleteVisible affect overrides only and preserve an optional base codec.",
        audit: "Are overrides bounded enough for full loading? Do deletions and sort-changing replacements preserve a full page? Is the same read transaction used for both tables?",
        limits: "No mutation replay, outbox, acknowledgment, source coverage, or conflict protocol yet. Overlays alone are not replication. The bounded-overrides assumption belongs to the future Replica design.",
        files: [core + "overlay/index.ts", core + "testing/index.ts"],
        code: `const view = overlay(tasks, { name: "task_overrides" });\nyield* tables.transaction(tx => Effect.gen(function* () {\n    yield* putVisible(tx, view, "a", { ...task, rank: 100 });\n    yield* deleteVisible(tx, view, "b");\n    return yield* loadVisible(tx, view, {\n        where: ilike(field("title"), "task%"),\n        orderBy: [{ field: field("rank") }], limit: 2\n    });\n}));`,
    },
    {
        title: "Next: declared schemas and migrations",
        concept:
            "A serializer reconstructs values. A database schema additionally declares fields, allowed types, constraints, defaults, and evolution. Typed SQL columns need that declaration; TypeScript generics or one sample row cannot supply it.",
        design: "Proposed next step: optional explicit schemas, persisted versions/fingerprints, and migration mechanics before adding native column layouts. Applications own migration definitions; Tables supplies coordinated row/index/version transitions. Reuse Effect SQL migrator conventions where appropriate. Keep schema-optional rows available.",
        audit: "Which scalar types and nested JSON fields should be declared first? Should app schemas normalize missing values? How are pending Replica mutators upgraded alongside stored rows?",
        limits: "This is a proposal, not implemented API. SQL BIGINT/INTEGER are bounded while JS bigint is not; PostgreSQL timestamps lose Temporal nanoseconds; SQL NULL cannot distinguish missing from null. Native mappings must explicitly constrain or preserve those semantics.",
        files: [
            "specs/2026-10-19-effect-tables-replica/schema-migrations.md",
            core + "model.ts",
            core + "storage/schema.ts",
            "packages/sql-ontology-storage/src/index.ts",
        ],
        docs: [
            ["Schema basics", doc("schema/basic-usage")],
            [
                "Effect SQL migrator source",
                "https://github.com/Effect-TS/effect/blob/main/packages/effect/src/sql/Migrator.ts",
            ],
        ],
        code: `// Proposed sequence, not existing API:\n// 1. Optional declared table schema and portable SQL mappings.\n// 2. Stored schema metadata + explicit version transitions.\n// 3. Migration rollback/drift tests on current layouts.\n// 4. Native SQLite/PostgreSQL columns + query equivalence.\n// 5. Replica outbox/mutator compatibility.`,
    },
    {
        title: "Verification, tooling, and future Replica",
        concept:
            "One shared contract exercises memory, fake IndexedDB, native Chromium, SQLite, and PGlite PostgreSQL. Focused tests cover planning work, SQL EXPLAIN plans, corruption, errors, cancellation, lifecycle, and adversarial input.",
        design: "The Effect-specific build preset contains lint guidance and @effect/vitest integration with Vite+. Base library configuration remains independent. Official skills point to installed Effect documentation. Browser benchmarks compare identical subset workloads with the existing persistence adapter and full-scan path.",
        audit: "Are important behavior guarantees backed by independent expected values as well as the shared evaluator? Which remaining performance tradeoffs matter before integrating the existing adapter?",
        limits: "Benchmarks are local development measurements, not CI thresholds or write-throughput claims. Replica still needs atomic base/outbox/replay/override updates, committed revisions and deltas, on-demand coverage, acknowledgments, and the TanStack bridge. Migrations and persistence-adapter rewiring remain explicit follow-ups.",
        files: [
            core + "testing/index.ts",
            "packages/build-config/src/effect.ts",
            "packages/build-config/src/effect.test.ts",
            "packages/indexeddb-ontology-storage/benchmarks/2026-10-19-chromium.md",
            ".vscode/extensions.json",
            ".vscode/settings.json",
            "AGENTS.md",
            ".agents/skills/README.md",
            ".changeset/tables-infrastructure.md",
            "specs/2026-10-19-effect-tables-replica/README.md",
        ],
        docs: [["Effect devtools", doc("getting-started/devtools")]],
        code: `pnpm exec vp run -F '@party-stack/ontology-storage*' test\npnpm exec vp run @party-stack/indexeddb-ontology-storage#test:browser\npnpm exec vp run @party-stack/indexeddb-ontology-storage#bench:browser\npnpm exec vp run ci`,
    },
];

const scenarios = [
    [
        "subset",
        "Complex subset + cursor",
        `and(inArray(field("project"), [1, 2]), ilike(field("title"), "task%"))`,
    ],
    [
        "refs",
        "Field–field + literal–field",
        `and(eq(1, field("project")), lt(field("rank"), field("budget")))`,
    ],
    ["residual", "Dynamic pattern residual", `like(field("title"), field("pattern"))`],
    [
        "rollback",
        "Cross-table rollback",
        `tables.withTransaction(Effect.gen(function* () {\n    yield* tables.delete(tasks, "a");\n    yield* tables.put(metadata, "revision", 42n);\n    return yield* Effect.fail("Rejected" as const);\n}))`,
    ],
    [
        "overlay",
        "Sparse overlay page",
        `putVisible(tx, view, "a", { ...a, title: "Hidden", rank: 0 });\ndeleteVisible(tx, view, "b");\nloadVisible(tx, view, { where: ilike(field("title"), "task%"),\n    orderBy: [{ field: field("rank") }], limit: 2 });`,
    ],
    [
        "rich",
        "Nested objects, bigint, Temporal, Map/Set",
        `const value = { nested: [{ count: 9007199254740993n }],\n    when: Temporal.Instant.from("2026-10-19T12:00:00.123456789Z"),\n    due: Temporal.PlainDate.from("2026-10-20"),\n    map: new Map([["key", new Set([1n, 2n])]]) };\nyield* tables.put(rich, 1, value);`,
    ],
    [
        "errors",
        "Unique reason + immutable index",
        `tables.put(users, "b", duplicate).pipe(\n    Effect.catchReason("OntologyStorageError", "UniqueConstraint", reason =>\n        Effect.succeed({ tag: reason._tag, table: reason.table, index: reason.index })\n    )\n)`,
    ],
] as const;
type Task = { title: string; project: number; rank: number; budget: number; pattern: string };
const all: Row<Task>[] = [
    { key: "a", value: { title: "Task Alpha", project: 1, rank: 2, budget: 4, pattern: "Task A%" } },
    { key: "b", value: { title: "Task Beta", project: 2, rank: 2, budget: 1, pattern: "Task B%" } },
    { key: "c", value: { title: "Task Gamma", project: 1, rank: 3, budget: 2, pattern: "none%" } },
    { key: "d", value: { title: "Other", project: 3, rank: 0, budget: 5, pattern: "%" } },
    { key: "e", value: { title: "Task Echo", project: 1, rank: 4, budget: 8, pattern: "Task%" } },
];
const indexes = ["title", "project", "rank", "budget"].map((name) => ({
    name,
    field: field(name),
    table: "review_tasks",
    version: 1,
}));
const pretty = (value: unknown): string => {
    const seen = new WeakSet<object>();
    return (
        JSON.stringify(
            value,
            (_, current: unknown) => {
                if (typeof current === "bigint") return `${current}n`;
                if (current instanceof Map) return { Map: [...current] };
                if (current instanceof Set) return { Set: [...current] };
                if (current && typeof current === "object") {
                    if (seen.has(current)) return "[shared/circular reference]";
                    seen.add(current);
                }
                return current;
            },
            2
        ) ?? "undefined"
    );
};
export function mountReview(sources: Record<string, string>) {
    const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let selected = 0;
    let saved: Record<string, { reviewed?: boolean; note?: string }> = {};
    try {
        saved = Schema.decodeUnknownSync(
            Schema.Record(
                Schema.String,
                Schema.Struct({
                    reviewed: Schema.optional(Schema.Boolean),
                    note: Schema.optional(Schema.String),
                })
            )
        )(JSON.parse(localStorage.getItem("tables-review-v2") ?? "{}"));
    } catch {
        /* Optional local persistence. */
    }
    const persist = () => {
        try {
            localStorage.setItem("tables-review-v2", JSON.stringify(saved));
        } catch {
            /* Review remains usable without storage. */
        }
    };
    const sourceButtons = (files: string[], parent: HTMLElement) => {
        parent.replaceChildren();
        for (const file of files) {
            const button = document.createElement("button");
            button.textContent = file;
            button.className = "source-link";
            button.onclick = () => {
                el<HTMLSelectElement>("source-file").value = file;
                showSource(file);
                el<HTMLDetailsElement>("source-details").open = true;
                el("source-view").scrollIntoView({ behavior: "smooth", block: "start" });
            };
            parent.append(button);
        }
    };
    const showSource = (file: string) => {
        el<HTMLSelectElement>("source-file").value = file;
        el("source-code").textContent = (sources[file] ?? "Source unavailable; rebuild review.")
            .split("\n")
            .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
            .join("\n");
        el("source-title").textContent = file;
    };
    for (const file of Object.keys(sources).sort()) {
        const option = document.createElement("option");
        option.value = option.textContent = file;
        el("source-file").append(option);
    }
    el("source-file").onchange = () => showSource(el<HTMLSelectElement>("source-file").value);
    function render() {
        const c = chapters[selected]!;
        el("chapter-title").textContent = c.title;
        el("concept").textContent = c.concept;
        el("design").textContent = c.design;
        el("audit").textContent = c.audit;
        el("limits").textContent = c.limits;
        el("example").textContent = c.code;
        sourceButtons(c.files, el("sources"));
        el("docs").replaceChildren();
        for (const [name, url] of c.docs ?? []) {
            const a = document.createElement("a");
            a.href = url;
            a.textContent = name;
            a.target = "_blank";
            a.rel = "noopener";
            el("docs").append(a);
        }
        el<HTMLInputElement>("reviewed").checked = !!saved[c.title]?.reviewed;
        el<HTMLTextAreaElement>("notes").value = saved[c.title]?.note ?? "";
        el("progress").textContent =
            `${chapters.filter((c) => saved[c.title]?.reviewed).length} / ${chapters.length} reviewed`;
        el<HTMLButtonElement>("prev").disabled = selected === 0;
        el<HTMLButtonElement>("next").disabled = selected === chapters.length - 1;
        el<HTMLSelectElement>("chapter-select").value = String(selected);
    }
    chapters.forEach((c, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `${i + 1}. ${c.title}`;
        el("chapter-select").append(o);
    });
    el("chapter-select").onchange = () => {
        selected = Number(el<HTMLSelectElement>("chapter-select").value);
        render();
    };
    el("prev").onclick = () => {
        selected--;
        render();
    };
    el("next").onclick = () => {
        selected++;
        render();
    };
    el("reviewed").onchange = el("notes").oninput = () => {
        saved[chapters[selected]!.title] = {
            reviewed: el<HTMLInputElement>("reviewed").checked,
            note: el<HTMLTextAreaElement>("notes").value,
        };
        persist();
        el("progress").textContent =
            `${chapters.filter((c) => saved[c.title]?.reviewed).length} / ${chapters.length} reviewed`;
    };
    el("export-notes").onclick = () => {
        const text =
            "# Effect Tables branch review\n\n" +
            chapters
                .map(
                    (c) =>
                        `## ${c.title}\n\nReviewed: ${saved[c.title]?.reviewed ? "yes" : "no"}\n\n${saved[c.title]?.note ?? ""}`
                )
                .join("\n\n");
        const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "effect-tables-review-notes.md";
        a.click();
        URL.revokeObjectURL(url);
    };
    for (const [value, label] of scenarios) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        el("scenario").append(option);
    }
    const scenarioCode = () => {
        el("scenario-code").textContent = scenarios.find(
            (s) => s[0] === el<HTMLSelectElement>("scenario").value
        )![2];
    };
    el("scenario").onchange = scenarioCode;
    el("run").onclick = async () => {
        const button = el<HTMLButtonElement>("run");
        button.disabled = true;
        el("result").textContent = "Running a fresh memory service…";
        try {
            const result = await Effect.runPromise(
                Effect.gen(function* () {
                    const tables = yield* Tables;
                    const tasks = Table.make<Task>({ name: "review_tasks" });
                    yield* tables.withTransaction(
                        Effect.gen(function* () {
                            for (const row of all) yield* tables.put(tasks, row.key, row.value);
                            for (const index of indexes) yield* tables.ensureIndex(tasks, index);
                        })
                    );
                    const id = el<HTMLSelectElement>("scenario").value;
                    if (id === "rollback") {
                        const metadata = Table.make<bigint>({ name: "metadata" });
                        const outcome = yield* tables
                            .withTransaction(
                                Effect.gen(function* () {
                                    yield* tables.delete(tasks, "a");
                                    yield* tables.put(metadata, "revision", 42n);
                                    return yield* Effect.fail("Rejected" as const);
                                })
                            )
                            .pipe(Effect.catch((error) => Effect.succeed({ rejected: error })));
                        return {
                            outcome,
                            rowRestored: yield* tables.get(tasks, "a"),
                            metadataAfterRollback: (yield* tables.get(metadata, "revision")) ?? "absent",
                        };
                    }
                    if (id === "rich") {
                        const table = Table.make<unknown>({ name: "rich" });
                        const value: Record<string, unknown> = {
                            nested: [{ count: 9007199254740993n, flags: [true, null] }],
                            when: Temporal.Instant.from("2026-10-19T12:00:00.123456789Z"),
                            due: Temporal.PlainDate.from("2026-10-20"),
                            map: new Map([["key", new Set([1n, 2n])]]),
                        };
                        yield* tables.put(table, 1, value);
                        const decoded = (yield* tables.get(table, 1)) as typeof value;
                        return {
                            nestedRoundTrip: decoded.nested,
                            decoded,
                        };
                    }
                    if (id === "errors") {
                        const users = Table.make<{ email: string }>({ name: "users" });
                        yield* tables.ensureIndex(users, {
                            name: "email",
                            field: field("email"),
                            unique: true,
                        });
                        yield* tables.put(users, "a", { email: "same@example.com" });
                        const duplicate = yield* tables.put(users, "b", { email: "same@example.com" }).pipe(
                            Effect.as<unknown>("unexpected"),
                            Effect.catchReason("OntologyStorageError", "UniqueConstraint", (reason) =>
                                Effect.succeed(Schema.encodeSync(Schema.Unknown)(reason))
                            )
                        );
                        const changedIndex = yield* tables
                            .ensureIndex(users, { name: "email", field: field("other") })
                            .pipe(
                                Effect.as<unknown>("unexpected"),
                                Effect.catchReason("OntologyStorageError", "IndexError", (reason) =>
                                    Effect.succeed({ tag: reason._tag, message: reason.message })
                                )
                            );
                        return { duplicate, changedIndex, rows: yield* tables.loadSubset(users) };
                    }
                    if (id === "overlay") {
                        const view = overlay(tasks, { name: "review_overrides" });
                        return yield* tables.transaction((tx) =>
                            Effect.gen(function* () {
                                yield* putVisible(tx, view, "a", {
                                    ...all[0]!.value,
                                    title: "Hidden",
                                    rank: 0,
                                });
                                yield* deleteVisible(tx, view, "b");
                                return {
                                    base: yield* tx.loadSubset(tasks),
                                    visible: yield* loadVisible(tx, view, {
                                        where: ilike(field("title"), "task%"),
                                        orderBy: [{ field: field("rank") }],
                                        limit: 2,
                                    }),
                                    overrides: yield* tx.loadSubset(view.overrides),
                                };
                            })
                        );
                    }
                    const where =
                        id === "refs"
                            ? and(eq(1, field("project")), lt(field("rank"), field("budget")))
                            : id === "residual"
                              ? like(field("title"), field("pattern"))
                              : and(inArray(field("project"), [1, 2]), ilike(field("title"), "task%"));
                    const query: Query = {
                        where,
                        orderBy: [{ field: field("rank"), direction: "desc" }],
                        limit: 2,
                    };
                    const first = yield* tables.loadSubset(tasks, query);
                    const after = first.length ? cursorOf(first.at(-1)!, query) : undefined;
                    return {
                        input: all,
                        query,
                        candidatePlan: selectPlan(indexes, where) ?? "Full scan",
                        firstPage: first,
                        cursor: after,
                        secondPage: yield* tables.loadSubset(tasks, { ...query, after }),
                        sql: compileQuery(
                            el<HTMLSelectElement>("dialect").value === "pg" ? "pg" : "sqlite",
                            indexes,
                            query
                        ),
                    };
                }).pipe(Effect.provide(Memory.layer))
            );
            el("result").textContent = pretty(result);
        } catch (error) {
            el("result").textContent = String(error);
        } finally {
            button.disabled = false;
        }
    };
    const inspect = () => {
        const query: Query = {
            where: eq(field("title"), el<HTMLInputElement>("literal").value),
            orderBy: [{ field: field("rank") }],
            limit: 2,
        };
        el("sql-inspect").textContent = pretty(
            compileQuery(el<HTMLSelectElement>("dialect").value === "pg" ? "pg" : "sqlite", indexes, query)
        );
    };
    el("literal").oninput = inspect;
    el("dialect").onchange = inspect;
    render();
    scenarioCode();
    inspect();
    showSource(chapters[0]!.files[0]!);
    el("runtime-status").textContent = "Ready · real Tables memory implementation · SQL compiler preview";
}
