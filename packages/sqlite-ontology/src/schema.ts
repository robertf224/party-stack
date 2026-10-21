import { ensureSQLiteAttachmentSchema } from "./attachments.js";
import type { SQLiteDatabase } from "./database.js";

/** Attachment IDs belong to one ontology authority per database. Application rows use Tables. */
export function ensureSQLiteOntologySchema(database: SQLiteDatabase, name: string): void {
    database.transaction(() => {
        database.exec(
            "CREATE TABLE IF NOT EXISTS party_stack_schema (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        );
        const previous = database
            .prepare("SELECT value FROM party_stack_schema WHERE key = ?")
            .get("__party_stack_ontology__") as { value: string } | undefined;
        if (previous && previous.value !== name)
            throw new Error(
                `SQLite database already belongs to ontology "${previous.value}"; create a separate database for "${name}".`
            );
        if (!previous)
            database
                .prepare("INSERT INTO party_stack_schema (key, value) VALUES (?, ?)")
                .run("__party_stack_ontology__", name);
        ensureSQLiteAttachmentSchema(database);
    })();
}
