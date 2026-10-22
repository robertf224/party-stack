import {
    createLiveOntology,
    o,
    type OntologyIR,
    type OntologyMutatorRegistry,
    type OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import { eq, queryOnce, type Collection } from "@tanstack/db";
import { Effect } from "effect";
import {
    createSQLiteTestBackend,
    makeSQLiteTestBackend,
    type SQLiteAttachmentBytesStore,
    type SQLiteAttachmentStorageOptions,
    type SQLiteDatabase,
} from "./sqliteBackend.js";

const conformanceIR: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "owner",
                    displayName: "Owner",
                    type: o.string({}),
                },
            ],
        },
        {
            name: "Asset",
            displayName: "Asset",
            pluralDisplayName: "Assets",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "owner",
                    displayName: "Owner",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({
                        name: "user",
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.inputReference({
                                name: "id",
                            }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.inputReference({
                                name: "title",
                            }),
                        },
                        {
                            property: ["owner"],
                            value: o.Expression.inputReference({
                                name: "owner",
                            }),
                        },
                    ],
                }),
            ],
        },
        {
            name: "renameNote",
            displayName: "Rename note",
            parameters: [
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({ objectType: "Note" }),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
            ],
            logic: [],
        },
        {
            name: "createAsset",
            displayName: "Create asset",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Asset",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.inputReference({
                                name: "id",
                            }),
                        },
                        {
                            property: ["attachment"],
                            value: o.Expression.inputReference({
                                name: "attachment",
                            }),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [
        {
            name: "noteTitle",
            displayName: "Note title",
            parameters: [
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({ objectType: "Note" }),
                },
            ],
            returnType: o.string({}),
        },
        {
            name: "currentUser",
            displayName: "Current user",
            parameters: [],
            returnType: o.string({}),
        },
    ],
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `${message} Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`
        );
    }
}

async function readObject(
    collection: Collection<Record<string, unknown>>,
    id: string
): Promise<Record<string, unknown> | undefined> {
    await queryOnce((query) =>
        query
            .from({ object: collection })
            .where(({ object }) => eq(object.id, id))
            .select(({ object }) => object)
    );
    return collection.get(id);
}

const mutators = {
    renameNote: async ({ tx, args }) => {
        await tx.mutate.Note!.update(args.note as string, {
            title: args.title,
        });
    },
} satisfies OntologyMutatorRegistry;

const queryFunctions = {
    noteTitle: async ({ tx, args }) => {
        const note = await tx.query<{ title: unknown } | undefined>((query, objects) =>
            query
                .from({ note: objects.Note! })
                .where(({ note }) => eq(note.id, args.note))
                .select(({ note }) => ({ title: note.title }))
                .findOne()
        );
        return note?.title;
    },
    currentUser: ({ context }) => context.user,
} satisfies OntologyQueryFunctionRegistry;

async function runSchemaCreation(database: SQLiteDatabase): Promise<void> {
    const open = (name: string) =>
        Effect.runPromise(
            Effect.scoped(
                createSQLiteTestBackend({
                    ir: conformanceIR,
                    database,
                    name,
                }).open({})
            )
        );
    await open("sqlite");
    await open("sqlite");
    assert(
        database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get("party_tables_rows"),
        "Native Tables rows were not created."
    );
}

async function runActionsAndContext(database: SQLiteDatabase): Promise<void> {
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteTestBackend({
                ir: conformanceIR,
                database,
                name: "sqlite",
            }),
        context: { user: "alice" },
    });
    try {
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
        });
        const note = await readObject(ontology.objects.Note!, "note-1");
        assertEqual(
            note && {
                id: note.id,
                title: note.title,
                owner: note.owner,
            },
            { id: "note-1", title: "Hello", owner: "alice" },
            "Declarative action or context.user failed."
        );
    } finally {
        await ontology.cleanup();
    }
}

async function runHandlers(database: SQLiteDatabase): Promise<void> {
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteTestBackend({
                ir: conformanceIR,
                database,
                name: "sqlite",
                mutators,
                queryFunctions,
            }),
        context: { user: "alice" },
    });
    try {
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Before",
        });
        await ontology.actions.renameNote!({
            note: "note-1",
            title: "After",
        });
        assertEqual(
            await ontology.queryFunctions.noteTitle!({ note: "note-1" }),
            "After",
            "Registered mutator or query function failed."
        );
        assertEqual(
            await ontology.queryFunctions.currentUser!({}),
            "alice",
            "Query function did not receive context.user."
        );
    } finally {
        await ontology.cleanup();
    }
}

async function runInlineAttachments(database: SQLiteDatabase): Promise<void> {
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteTestBackend({
                ir: conformanceIR,
                database,
                name: "sqlite",
            }),
    });
    try {
        const created = await ontology.attachments.create(new Blob(["inline"], { type: "text/plain" }), {
            target: {
                kind: "objectProperty",
                objectType: "Asset",
                property: "attachment",
            },
        });
        await ontology.actions.createAsset!({
            id: "asset-1",
            attachment: created.attachment,
        });
        assertEqual(
            await (await ontology.attachments.blob(created.attachment)).text(),
            "inline",
            "Inline attachment bytes were not persisted."
        );
    } finally {
        await ontology.cleanup();
    }
}

function runTransactionRollback(database: SQLiteDatabase): void {
    database.exec(`CREATE TABLE rollback_test (id TEXT PRIMARY KEY)`);
    try {
        database.transaction(() => {
            database.prepare(`INSERT INTO rollback_test (id) VALUES (?)`).run("rolled-back");
            throw new Error("intentional rollback");
        })();
    } catch {
        // Expected.
    }
    assertEqual(
        database.prepare(`SELECT id FROM rollback_test`).all(),
        [],
        "Synchronous transaction did not roll back."
    );
}

class MemoryAttachmentBytesStore implements SQLiteAttachmentBytesStore {
    readonly blobs = new Map<string, Blob>();

    write(id: string, blob: Blob): Promise<void> {
        this.blobs.set(id, blob);
        return Promise.resolve();
    }

    read(id: string): Promise<Blob> {
        const blob = this.blobs.get(id);
        return blob ? Promise.resolve(blob) : Promise.reject(new Error(`Missing external bytes "${id}".`));
    }

    delete(id: string): Promise<void> {
        this.blobs.delete(id);
        return Promise.resolve();
    }
}

class DelayedAttachmentBytesStore extends MemoryAttachmentBytesStore {
    private releaseWrite!: () => void;
    private readonly writeGate: Promise<void>;
    private readonly markStarted: () => void;
    readonly writeStarted: Promise<void>;
    deleteCalls = 0;

    constructor() {
        super();
        let started!: () => void;
        this.writeStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        this.writeGate = new Promise<void>((resolve) => {
            this.releaseWrite = resolve;
        });
        this.markStarted = started;
    }

    override async write(id: string, blob: Blob): Promise<void> {
        this.markStarted();
        await this.writeGate;
        await super.write(id, blob);
    }

    override delete(id: string): Promise<void> {
        this.deleteCalls++;
        return super.delete(id);
    }

    release(): void {
        this.releaseWrite();
    }
}

async function runExternalAttachments(database: SQLiteDatabase): Promise<void> {
    const bytes = new MemoryAttachmentBytesStore();
    const storage = {
        external: { bytes },
    } satisfies SQLiteAttachmentStorageOptions;
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteTestBackend({
                ir: conformanceIR,
                database,
                name: "sqlite",
                attachmentStorage: storage,
            }),
    });
    try {
        const created = await ontology.attachments.create(new Blob(["external"], { type: "text/plain" }), {
            target: {
                kind: "objectProperty",
                objectType: "Asset",
                property: "attachment",
            },
        });
        await ontology.actions.createAsset!({
            id: "external-asset",
            attachment: created.attachment,
        });
        assertEqual(
            await (await ontology.attachments.blob(created.attachment)).text(),
            "external",
            "External authoritative bytes were not readable."
        );
    } finally {
        await ontology.cleanup();
    }

    const delayedBytes = new DelayedAttachmentBytesStore();
    const delayed = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteTestBackend({
                ir: conformanceIR,
                database,
                name: "sqlite",
                attachmentStorage: {
                    external: { bytes: delayedBytes },
                },
            }),
    });
    try {
        const created = await delayed.attachments.create(new Blob(["delayed"], { type: "text/plain" }), {
            target: {
                kind: "objectProperty",
                objectType: "Asset",
                property: "attachment",
            },
        });
        const action = delayed.actions.createAsset!({
            id: "delayed-asset",
            attachment: created.attachment,
        });
        void action.catch(() => undefined);
        await delayedBytes.writeStarted;
        assertEqual(
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const backend = yield* makeSQLiteTestBackend({
                            ir: conformanceIR,
                            database,
                            name: "sqlite",
                            attachmentStorage: { external: { bytes: delayedBytes } },
                        });
                        return yield* backend.collectGarbage({ orphanGraceMs: 0 });
                    })
                )
            ),
            0,
            "Collector claimed an active upload."
        );
        delayedBytes.release();
        await action;
        assertEqual(delayedBytes.deleteCalls, 0, "Collector deleted an active upload.");
    } finally {
        delayedBytes.release();
        await delayed.cleanup();
    }
}

export const sqliteOntologyConformanceCases = [
    { id: "schema", name: "creates schemas idempotently", run: runSchemaCreation },
    {
        id: "actions-context",
        name: "persists declarative actions with context.user",
        run: runActionsAndContext,
    },
    {
        id: "handlers",
        name: "runs registered mutators and query functions",
        run: runHandlers,
    },
    {
        id: "inline-attachments",
        name: "persists inline SQLite attachment bytes",
        run: runInlineAttachments,
    },
    {
        id: "transaction-rollback",
        name: "rolls back synchronous transactions",
        run: runTransactionRollback,
    },
    {
        id: "external-attachments",
        name: "uses injectable external attachment bytes safely",
        run: runExternalAttachments,
    },
] as const;

export type SQLiteOntologyConformanceCaseId = (typeof sqliteOntologyConformanceCases)[number]["id"];

export async function runSQLiteOntologyConformanceCase(
    id: SQLiteOntologyConformanceCaseId,
    database: SQLiteDatabase
): Promise<void> {
    const test = sqliteOntologyConformanceCases.find((candidate) => candidate.id === id);
    assert(test, `Unknown SQLite ontology conformance case "${id}".`);
    await test.run(database);
}

export { conformanceIR as sqliteOntologyConformanceIR };
