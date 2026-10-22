import { createRequire } from "node:module";
import { describe, it } from "vite-plus/test";
import { runSQLiteOntologyConformanceCase, sqliteOntologyConformanceCases } from "./sqlite.js";
import type { SQLiteDatabase } from "./sqliteBackend.js";

interface BetterSQLiteDatabase extends SQLiteDatabase {
    close(): void;
}

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (path: string) => BetterSQLiteDatabase;

describe("better-sqlite3 ontology conformance", () => {
    for (const testCase of sqliteOntologyConformanceCases) {
        it(`${testCase.name}`, async () => {
            const database = new BetterSqlite3(":memory:");
            try {
                await runSQLiteOntologyConformanceCase(testCase.id, database);
            } finally {
                database.close();
            }
        });
    }
});
