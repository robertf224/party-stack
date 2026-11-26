import { Effect, Exit } from "effect";
import { applyQuery } from "../query/evaluate.js";
import { Table, field, where, type Query } from "../table-api.js";
import type { TablesService } from "../tables.js";

const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error(message);
};
interface Employee {
    readonly badge: string;
    readonly desk: string;
    readonly room: string;
    readonly skills: readonly string[];
    readonly teams: readonly string[];
}
const employees: readonly { readonly key: string; readonly value: Employee }[] = [
    { key: "a", value: { badge: "Alpha", desk: "x", room: "y", skills: ["welding"], teams: ["red"] } },
    { key: "b", value: { badge: "beta", desk: "y", room: "x", skills: ["typing"], teams: ["welding"] } },
    { key: "c", value: { badge: "x", desk: "Alpha", room: "beta", skills: [], teams: [] } },
];
const names = (rows: readonly { readonly key: unknown }[]) => rows.map((row) => row.key).join();

/** Index removal: definitions, entries and native structures leave together, so the
 * same name can later index another field without stale entries or constraints. */
export const runIndexRemovalContract = Effect.fnUntraced(function* (tables: TablesService) {
    const staff = Table.make<Employee>({ name: "index-removal" });
    let rows = [...employees];
    const expect = (query: Query, message: string) =>
        Effect.gen(function* () {
            const actual = yield* tables.query(staff, query);
            assert(names(actual) === names(applyQuery(rows, query)), message);
        });
    yield* tables.putMany(staff, rows);
    yield* tables.ensureIndex(staff, { name: "lookup", field: field("badge"), unique: true });
    yield* tables.ensureIndex(staff, { name: "skills", field: field("skills"), multiEntry: true });
    const listed = yield* tables.read((tx) => tx.indexes(staff));
    assert(
        JSON.stringify(listed.map((index) => index.name).sort()) === JSON.stringify(["lookup", "skills"]),
        "Index listing names every ensured index and hides the schema stamp"
    );
    const lookup = listed.find((index) => index.name === "lookup");
    assert(
        lookup?.unique === true && !lookup.multiEntry && lookup.field.path.join() === "badge",
        "Index listing returns the ensured definition"
    );
    const duplicate = {
        key: "d",
        value: { badge: "Alpha", desk: "Alpha", room: "Alpha", skills: ["typing"], teams: ["red"] },
    };
    assert(
        !(yield* tables.insert(staff, duplicate.key, duplicate.value)),
        "Unique index rejects a duplicate"
    );

    const rolledBack = yield* Effect.exit(
        tables.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.dropIndex(staff, "lookup");
                assert(
                    !(yield* tx.indexes(staff)).some((index) => index.name === "lookup"),
                    "A drop is visible later in its transaction"
                );
                assert(
                    yield* tx.insert(staff, duplicate.key, duplicate.value),
                    "A dropped unique index no longer constrains its transaction"
                );
                return yield* Effect.fail("abort index drop");
            })
        )
    );
    assert(Exit.isFailure(rolledBack), "The index drop transaction was rolled back");
    assert(
        (yield* tables.indexes(staff)).some((index) => index.name === "lookup"),
        "A rolled-back drop keeps the definition"
    );
    assert(
        !(yield* tables.insert(staff, duplicate.key, duplicate.value)),
        "A rolled-back drop keeps uniqueness"
    );

    yield* tables.dropIndex(staff, "lookup");
    yield* tables.dropIndex(staff, "skills");
    assert((yield* tables.indexes(staff)).length === 0, "Dropped indexes are no longer listed");
    assert(
        yield* tables.insert(staff, duplicate.key, duplicate.value),
        "A dropped unique index no longer constrains later transactions"
    );
    rows = [...rows, duplicate];
    yield* expect({ where: where.eq(field("badge"), "Alpha") }, "Equality on a dropped index field");
    yield* expect(
        { where: where.contains(field("skills"), "typing") },
        "Membership on a dropped array index"
    );
    yield* expect({ orderBy: [{ field: field("badge") }], limit: 3 }, "Order on a dropped index field");

    yield* tables.dropIndex(staff, "lookup");
    yield* tables.dropIndex(staff, "never-ensured");
    yield* tables.dropIndex(Table.make<Employee>({ name: "index-removal-empty" }), "lookup");
    assert(
        Exit.isFailure(yield* Effect.exit(tables.dropIndex(staff, "__party_tables_schema__"))),
        "The schema stamp cannot be dropped"
    );
    assert(
        Exit.isFailure(yield* Effect.exit(tables.withReadTransaction(tables.dropIndex(staff, "lookup")))),
        "Dropping an index requires a write transaction"
    );

    // The same name on another, non-unique field, then dropped and redefined again
    // within one transaction: no stale entries, projections or constraints remain.
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.ensureIndex(staff, { name: "lookup", field: field("badge") });
            yield* tx.dropIndex(staff, "lookup");
            yield* tx.ensureIndex(staff, { name: "lookup", field: field("desk") });
            assert(
                names(yield* tx.query(staff, { where: where.eq(field("desk"), "Alpha") })) === "c,d",
                "A same-name index on another field answers queries in its transaction"
            );
        })
    );
    // The earlier unique "lookup" left no constraint behind: "desk" repeats "Alpha".
    assert(
        names(yield* tables.query(staff, { where: where.eq(field("desk"), "Alpha") })) === "c,d",
        "Duplicate values are accepted by the non-unique replacement"
    );
    for (const value of ["x", "y", "Alpha", "alpha"])
        yield* expect({ where: where.eq(field("desk"), value) }, `Replacement equality for ${value}`);
    yield* expect({ where: where.ilike(field("desk"), "alpha") }, "Replacement case-insensitive match");
    yield* expect({ where: where.ilike(field("desk"), "X%") }, "Replacement case-insensitive prefix");
    yield* expect({ orderBy: [{ field: field("desk") }] }, "Replacement order has no stale entries");
    yield* expect(
        { orderBy: [{ field: field("desk"), direction: "desc" }], limit: 2 },
        "Replacement descending window"
    );

    // Each "room" repeats another row's "desk", so a stale "lookup" entry would
    // fail the unique backfill. A stale "skills" element would match "teams".
    yield* tables.ensureIndex(staff, { name: "skills", field: field("skills"), multiEntry: true });
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.dropIndex(staff, "lookup");
            yield* tx.dropIndex(staff, "skills");
            yield* tx.ensureIndex(staff, { name: "lookup", field: field("room"), unique: true });
            yield* tx.ensureIndex(staff, { name: "skills", field: field("teams"), multiEntry: true });
        })
    );
    const redefined = yield* tables.indexes(staff);
    const relookup = redefined.find((index) => index.name === "lookup");
    const reskills = redefined.find((index) => index.name === "skills");
    assert(
        redefined.length === 2 &&
            relookup?.unique === true &&
            relookup.field.path.join() === "room" &&
            reskills?.multiEntry === true &&
            reskills.field.path.join() === "teams",
        "Index listing reflects the redefinitions"
    );
    assert(
        !(yield* tables.insert(staff, "e", { badge: "e", desk: "e", room: "y", skills: [], teams: [] })),
        "A unique redefinition enforces its own field"
    );
    yield* expect({ where: where.gte(field("room"), "x") }, "Unique redefinition range");
    yield* expect({ orderBy: [{ field: field("room"), direction: "desc" }] }, "Unique redefinition order");
    for (const value of ["welding", "typing", "red"])
        yield* expect(
            { where: where.contains(field("teams"), value) },
            `Array redefinition membership for ${value}`
        );
});
