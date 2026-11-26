import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import { joinNoteMarkdown } from "./noteContent";
import type { OwnedStorageService } from "@party-stack/ontology-backend/owned";
import type { TablesService } from "@party-stack/ontology-storage/tables";

const migrations = Table.make<boolean>({ name: "notes:app-migrations" });
const modelIdentity = Schema.fromJsonString(
    Schema.Struct({
        objects: Schema.Array(Schema.Struct({ name: Schema.String })),
    })
);

export const migrateNoteDocuments = Effect.fn("Notes.migrateDocuments")(
    function* (storage: OwnedStorageService, tables: TablesService) {
        // Table operations join the owned transaction, so the marker, documents
        // and their journal publication commit together.
        yield* storage.transaction((tx) =>
            Effect.gen(function* () {
                if (yield* tables.get(migrations, "whole-documents-v1")) return;
                for (const { key, value } of yield* tx.loadSubset("Note")) {
                    if (value.kind !== "note") continue;
                    const title = value.title as string;
                    const body = value.bodyMarkdown as string;
                    yield* tx.patch("Note", key, [
                        {
                            path: ["bodyMarkdown"],
                            value: joinNoteMarkdown(title === "Untitled" && !body ? "" : title, body),
                        },
                    ]);
                }
                yield* tables.put(migrations, "whole-documents-v1", true);
            })
        );
    },
    Effect.mapError((cause) => classifyBackendFailure("notes.migrate", cause))
);

// This app migration adds Preferences; existing object representations are unchanged.
// Reopen the model stamp once, preserving all object tables, bytes and journal rows.
export const migrateNotesStorage = Effect.fn("Notes.migrateStorage")(
    function* (tables: TablesService, namespace: string) {
        yield* tables.transaction((tx) =>
            Effect.gen(function* () {
                if (yield* tx.get(migrations, "preferences-in-notes")) return;
                const model = Table.make<{ signature: string }>({
                    name: JSON.stringify(["ontology", namespace, "model"]),
                });
                const stamp = yield* tx.get(model, "definition");
                if (stamp) {
                    const identity = yield* Schema.decodeUnknownEffect(modelIdentity)(stamp.signature);
                    const names = identity.objects
                        .map(({ name }) => name)
                        .sort()
                        .join(",");
                    if (names === "Note,NoteAttachment,Notebook") yield* tx.delete(model, "definition");
                    else if (names !== "Note,NoteAttachment,Notebook,Preferences")
                        return yield* new BackendError({
                            operation: "notes.migrate",
                            kind: "SchemaMismatch",
                            retryable: false,
                            message: "Unexpected Notes storage definition.",
                        });
                }
                yield* tx.put(migrations, "preferences-in-notes", true);
            })
        );
    },
    Effect.mapError((cause) => classifyBackendFailure("notes.migrate", cause))
);

// Upgrade only the known previous definitions. Keep sequence numbers, cursors,
// cached objects, offline pins and every pending outbox entry in their namespace.
