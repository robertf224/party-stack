import type { SecretStore } from "@party-stack/runtime";
import type { SQLiteDatabase } from "@party-stack/sqlite-ontology";

export class DurableObjectSecretStore implements SecretStore {
    constructor(
        private readonly database: SQLiteDatabase,
        private readonly owner: string,
        private readonly namespace: string
    ) {
        database.exec(`
            CREATE TABLE IF NOT EXISTS party_stack_runtime_secrets (
                owner TEXT NOT NULL,
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (owner, namespace, key)
            )
        `);
    }

    get(key: string): Promise<string | undefined> {
        const row = this.database
            .prepare(
                `SELECT value
                 FROM party_stack_runtime_secrets
                 WHERE owner = ? AND namespace = ? AND key = ?`
            )
            .get(this.owner, this.namespace, key) as { value: string } | undefined;
        return Promise.resolve(row?.value);
    }

    set(key: string, value: string): Promise<void> {
        this.database
            .prepare(
                `INSERT INTO party_stack_runtime_secrets (
                    owner, namespace, key, value
                 ) VALUES (?, ?, ?, ?)
                 ON CONFLICT(owner, namespace, key) DO UPDATE SET
                    value = excluded.value`
            )
            .run(this.owner, this.namespace, key, value);
        return Promise.resolve();
    }

    delete(key: string): Promise<void> {
        this.database
            .prepare(
                `DELETE FROM party_stack_runtime_secrets
                 WHERE owner = ? AND namespace = ? AND key = ?`
            )
            .run(this.owner, this.namespace, key);
        return Promise.resolve();
    }

    destroy(): void {
        this.database
            .prepare(
                `DELETE FROM party_stack_runtime_secrets
                 WHERE owner = ? AND namespace = ?`
            )
            .run(this.owner, this.namespace);
    }
}
