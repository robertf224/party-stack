import { DurableObject } from "cloudflare:workers";
import { createSQLiteOntologyBackendAdapter } from "@party-stack/sqlite-ontology";
import {
    runSQLiteOntologyConformanceCase,
    sqliteOntologyConformanceIR,
    type SQLiteOntologyConformanceCaseId,
} from "@party-stack/sqlite-ontology/testing";
import { createDurableObjectSQLiteDatabase, type DurableObjectSQLiteDatabase } from "../src/index.js";

export class SQLiteOntologyTestDurableObject extends DurableObject {
    readonly database: DurableObjectSQLiteDatabase;
    readonly initialized: Promise<void>;

    constructor(state: DurableObjectState, env: Cloudflare.Env) {
        super(state, env);
        this.database = createDurableObjectSQLiteDatabase(state.storage);
        this.initialized = state.blockConcurrencyWhile(async () => {
            createSQLiteOntologyBackendAdapter({
                ir: sqliteOntologyConformanceIR,
                database: this.database,
                name: "blocked",
            });
        });
    }

    async runConformance(id: SQLiteOntologyConformanceCaseId): Promise<void> {
        await this.initialized;
        await runSQLiteOntologyConformanceCase(id, this.database);
    }

    async destroyStorage(): Promise<void> {
        await this.database.destroy();
    }

    fetch(): Response {
        return new Response("ok");
    }
}

export default {
    fetch(): Response {
        return new Response("ok");
    },
};
