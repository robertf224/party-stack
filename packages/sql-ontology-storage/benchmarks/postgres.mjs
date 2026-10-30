import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Pg from "@effect/sql-pg/PgClient";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { Effect, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { make } from "../lib/tables.js";
import { startPostgres } from "../src/postgres.setup.ts";

// Compare coordination/journal implementations against the same portable core.
// Baseline sources are temporary test oracles; no old implementation ships.
const baseline = process.argv[2] ?? "faa2bdbb";
let url = process.env.PARTY_STACK_TEST_POSTGRES_URL;
if (!/^[0-9a-f]{7,40}$/.test(baseline)) throw new Error("Pass a baseline commit hash.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(root, ".postgres-benchmark-"));
const schema = `benchmark_${crypto.randomUUID().replaceAll("-", "")}`;
const ir = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            logic: [],
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
const admin = (effect) =>
    Effect.runPromise(
        effect.pipe(Effect.provide(Pg.layer({ url: Redacted.make(url), maxConnections: 1 })), Effect.scoped)
    );
let created = false;
let postgres;
try {
    if (!url) {
        postgres = await startPostgres();
        url = postgres.getConnectionUri();
    }
    const source = (path) =>
        execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
    await writeFile(
        join(temporary, "tables.ts"),
        source("packages/sql-ontology-storage/src/tables.ts").replace(
            '"./compiler.js"',
            JSON.stringify(pathToFileURL(join(root, "lib/compiler.js")).href)
        )
    );
    let owned = source("packages/ontology-backend/src/owned.ts");
    for (const name of ["clients", "delivery", "policy", "references", "index"]) {
        owned = owned.replaceAll(
            `"./${name}.js"`,
            JSON.stringify(pathToFileURL(resolve(root, "../ontology-backend/lib", `${name}.js`)).href)
        );
    }
    await writeFile(join(temporary, "owned.ts"), owned);
    const oldTables = (await import(pathToFileURL(join(temporary, "tables.ts")).href)).make;
    const oldOwned = (await import(pathToFileURL(join(temporary, "owned.ts")).href)).makeOwnedBackend;
    await admin(
        Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE SCHEMA ${sql(schema)}`;
        })
    );
    created = true;
    const samples = [];
    await Effect.runPromise(
        Effect.gen(function* () {
            for (const delayMs of [0, 20])
                for (let round = 0; round < 3; round++)
                    for (const strategy of ["before", "after"]) {
                        const tables = yield* (strategy === "before" ? oldTables : make)({
                            prefix: `bench_${crypto.randomUUID().replaceAll("-", "")}`,
                        });
                        let attempts = 0;
                        const backend = yield* (strategy === "before" ? oldOwned : makeOwnedBackend)({
                            namespace: "benchmark",
                            tables,
                            ir,
                            history: { maxCommits: Infinity },
                            mutators: {
                                increment: (tx, action) =>
                                    Effect.gen(function* () {
                                        attempts++;
                                        const row = yield* tx.get("Counter", action.parameters.id);
                                        if (delayMs) yield* Effect.sleep(`${delayMs} millis`);
                                        yield* tx.put("Counter", {
                                            id: action.parameters.id,
                                            count: row.count + 1,
                                        });
                                    }),
                            },
                        });
                        yield* backend.storage.transaction((tx) =>
                            Effect.forEach(
                                Array.from({ length: 16 }, (_, i) => `id-${i}`),
                                (id) => tx.put("Counter", { id, count: 0 }),
                                { discard: true }
                            )
                        );
                        const start = performance.now();
                        yield* Effect.all(
                            Array.from({ length: 16 }, (_, i) =>
                                backend.applyAction({
                                    id: `op-${i}`,
                                    name: "increment",
                                    parameters: { id: `id-${i}` },
                                })
                            ),
                            { concurrency: 8 }
                        );
                        const elapsedMs = Math.round(performance.now() - start);
                        const state = yield* backend.loadSubset({ objectType: "Counter" });
                        if (state.rows.length !== 16 || state.rows.some((row) => row.value.count !== 1))
                            throw new Error("Incorrect benchmark state");
                        const sample = { strategy, delayMs, round, elapsedMs, attempts };
                        samples.push(sample);
                        console.log(JSON.stringify(sample));
                    }
        }).pipe(
            Effect.provide(
                Pg.layer({
                    url: Redacted.make(url),
                    maxConnections: 12,
                    startupParameters: { search_path: schema },
                })
            ),
            Effect.scoped
        )
    );
    console.log(JSON.stringify({ baseline, actions: 16, concurrency: 8, samples }));
} finally {
    try {
        if (created)
            await admin(
                Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`DROP SCHEMA ${sql(schema)} CASCADE`;
                })
            );
    } finally {
        try {
            await rm(temporary, { recursive: true, force: true });
        } finally {
            await postgres?.stop();
        }
    }
}
