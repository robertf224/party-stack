import { make as makeNodeRuntime } from "@party-stack/node-runtime";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeStorageBackend } from "@party-stack/ontology-backend/storage";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Table } from "@party-stack/ontology-storage/tables";
import { RuntimePartition } from "@party-stack/runtime";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { defaultNotebookId } from "../ontology/folders";
import { migrateNoteDocuments, migrateNotesStorage } from "../ontology/migrations";
import { notesMutators } from "../ontology/mutators";
import { joinNoteMarkdown } from "../ontology/noteContent";
import { notesOntology } from "../ontology/ontology";

const namespace = "notes-v1";
const open = Effect.gen(function* () {
    const runtime = yield* makeNodeRuntime({ dataDirectory: "temp/notes" }).pipe(
        Effect.provideService(RuntimePartition, { owner: "notes-server", namespace })
    );
    const blobs = yield* makeBlobStorage({
        tables: runtime.tables,
        bytes: runtime.bytes,
        namespace,
        ...exclusiveOwnerLiveness(runtime.tables),
        attachmentBytesRetentionMode: "authoritative",
    });
    const values = makeEncryptedValues(namespace, runtime.encryptionKeyring!);
    yield* migrateNotesStorage(runtime.tables, namespace);
    const backend = yield* makeStorageBackend({
        namespace,
        ir: notesOntology,
        mutators: notesMutators,
        tables: runtime.tables,
        blobs,
        encryptionKeyring: runtime.encryptionKeyring,
        queryFunctions: {
            sealSecret: (_tx, parameters) =>
                values
                    .encrypt(Schema.String, parameters.value as string)
                    .pipe(Effect.mapError((cause) => classifyBackendFailure("notes.encrypt", cause))),
        },
    });
    const appMigrations = Table.make<boolean>({ name: "notes:app-migrations" });
    if (!(yield* runtime.tables.get(appMigrations, "single-device-v1"))) {
        yield* backend.storage.transaction((tx) =>
            Effect.gen(function* () {
                const folders = yield* tx.loadSubset("Notebook");
                for (const { key, value } of folders) {
                    const id = String(key).replace(/^(ada|grace|linus):/, "device:");
                    if (!(yield* tx.get("Notebook", id)))
                        yield* tx.put("Notebook", { ...value, id, ownerId: "device" });
                }
                for (const { key, value } of yield* tx.loadSubset("Note")) {
                    const seed = /^(grace|linus):(welcome|weekend|ideas|project|secure|login)$/.test(
                        String(key)
                    );
                    const untouched =
                        value.createdAt instanceof Temporal.Instant &&
                        value.updatedAt instanceof Temporal.Instant &&
                        value.createdAt.equals(value.updatedAt);
                    if (seed && untouched) {
                        yield* tx.delete("Note", key);
                        continue;
                    }
                    yield* tx.patch("Note", key, [
                        { path: ["ownerId"], value: "device" },
                        {
                            path: ["notebookId"],
                            value: String(value.notebookId).replace(/^(ada|grace|linus):/, "device:"),
                        },
                    ]);
                }
                for (const { key } of folders)
                    if (/^(ada|grace|linus):/.test(String(key))) yield* tx.delete("Notebook", key);
                for (const { key, value } of yield* tx.loadSubset("NoteAttachment")) {
                    if (yield* tx.get("Note", String(value.noteId)))
                        yield* tx.patch("NoteAttachment", key, [{ path: ["ownerId"], value: "device" }]);
                    else yield* tx.delete("NoteAttachment", key);
                }
            })
        );
        yield* runtime.tables.put(appMigrations, "single-device-v1", true);
    }
    yield* migrateNoteDocuments(backend.storage, runtime.tables);
    const now = Temporal.Now.instant();
    const folders = [
        { id: "personal", name: "Personal", color: "#d4a72c" },
        { id: "work", name: "Work", color: "#829bbc" },
        { id: "ideas", name: "Ideas", color: "#a394bf" },
    ];
    for (const userId of ["device"]) {
        yield* backend.storage.transaction((tx) =>
            Effect.gen(function* () {
                if (!(yield* tx.get("Preferences", userId)))
                    yield* tx.put("Preferences", {
                        id: userId,
                        ownerId: userId,
                        foldersWidth: 240,
                        notesWidth: 300,
                    });
                if (!(yield* tx.get("Notebook", defaultNotebookId(userId))))
                    yield* tx.put("Notebook", {
                        id: defaultNotebookId(userId),
                        ownerId: userId,
                        name: "Notes",
                        color: "#d4a72c",
                    });
            })
        );
        const prefix = userId.split("@")[0]!;
        const seedMarker = `seeded:${userId}`;
        if (yield* runtime.tables.get(appMigrations, seedMarker)) continue;
        if (yield* backend.storage.read((tx) => tx.get("Notebook", `${prefix}:personal`))) {
            yield* runtime.tables.put(appMigrations, seedMarker, true);
            continue;
        }
        const secret = yield* values.encrypt(
            Schema.String,
            "Recovery phrase: this is a sample secure note. Replace it with your own text."
        );
        const login = yield* values.encrypt(
            Schema.String,
            JSON.stringify({
                username: "hello@example.test",
                password: "example-password",
                url: "https://example.test",
            })
        );
        yield* backend.storage.transaction((tx) =>
            Effect.gen(function* () {
                for (const folder of folders)
                    yield* tx.put("Notebook", { ...folder, id: `${prefix}:${folder.id}`, ownerId: userId });
                for (const [id, title, bodyMarkdown, notebookId, kind, encrypted] of [
                    [
                        "welcome",
                        "A little room for everything",
                        "A place for the things you want to keep.\n\n## Make yourself at home\n\n- Write with **Markdown** or use the toolbar.\n- Drop a photo or attach a file.\n- Keep a note offline with the cloud button.\n\nYour notes save as you write.",
                        "personal",
                        "note",
                        undefined,
                    ],
                    [
                        "weekend",
                        "A slower weekend",
                        "## Saturday\n\n- [ ] Coffee and the bookshop\n- [ ] Pick up flowers\n- [ ] Take the long way home\n\n> Leave a little space for nothing.",
                        "personal",
                        "note",
                        undefined,
                    ],
                    [
                        "ideas",
                        "Things worth making",
                        "- A reading nook by the window\n- A tiny website for favorite recipes\n- A better way to keep all these ideas",
                        "ideas",
                        "note",
                        undefined,
                    ],
                    [
                        "project",
                        "Project notes",
                        "## This week\n\nKeep the scope small. Make the useful part work beautifully.\n\n1. Sketch the first version\n2. Try it with real data\n3. Remove what gets in the way",
                        "work",
                        "note",
                        undefined,
                    ],
                    ["secure", "Recovery information", "", "personal", "secure", secret],
                    ["login", "Example account", "", "personal", "login", login],
                ] as const)
                    yield* tx.put("Note", {
                        id: `${prefix}:${id}`,
                        ownerId: userId,
                        title,
                        bodyMarkdown: kind === "note" ? joinNoteMarkdown(title, bodyMarkdown) : bodyMarkdown,
                        notebookId: `${prefix}:${notebookId}`,
                        kind,
                        secret: encrypted,
                        favorite: id === "welcome",
                        trashed: false,
                        createdAt: now,
                        updatedAt: now,
                    });
                yield* runtime.tables.put(appMigrations, seedMarker, true);
            })
        );
    }
    // One-time migration of the earlier gallery prototype. The marker prevents
    // a deliberately removed document embed from reappearing on the next open.
    const migrations = Table.make<boolean>({ name: "notes:app-migrations" });
    if (!(yield* runtime.tables.get(migrations, "markdown-attachments-v1"))) {
        yield* backend.storage.transaction((tx) =>
            Effect.gen(function* () {
                const attachments = yield* tx.loadSubset("NoteAttachment");
                const grouped = new Map<string, string[]>();
                for (const { value } of attachments) {
                    const noteId = String(value.noteId);
                    const entries = grouped.get(noteId) ?? [];
                    entries.push(String(value.id));
                    grouped.set(noteId, entries);
                }
                for (const [noteId, ids] of grouped) {
                    const note = yield* tx.get("Note", noteId);
                    if (!note || note.kind !== "note") continue;
                    const body = String(note.bodyMarkdown ?? "");
                    const embeds = ids
                        .filter((id) => !body.includes(`attachment:${id}`))
                        .map((id) => `![Attachment](attachment:${id})`);
                    if (embeds.length)
                        yield* tx.patch("Note", noteId, [
                            { path: ["bodyMarkdown"], value: `${body}\n\n${embeds.join("\n\n")}` },
                        ]);
                }
            })
        );
        yield* runtime.tables.put(migrations, "markdown-attachments-v1", true);
    }
    const server = yield* makeOntologyServer({
        enableRealtime: true,
        kind: "owned",
        backend,
        ir: notesOntology,
        authenticate: () => Effect.succeed({ userId: "device" }),
    });
    return yield* makeOntologyHttpHandler(server);
});
class NotesServer extends Context.Service<NotesServer, Effect.Success<typeof open>>()("notes/Server") {}
const owner = ManagedRuntime.make(Layer.effect(NotesServer, open));
if (import.meta.hot) import.meta.hot.dispose(() => owner.dispose());
export async function handleNotes(request: Request) {
    return (await owner.runPromise(NotesServer))(request);
}
