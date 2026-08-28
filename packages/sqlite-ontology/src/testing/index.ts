import {
    createLiveOntology,
    o,
    type OntologyIR,
    type OntologyMutatorRegistry,
    type OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import { createDefaultRuntime } from "@party-stack/runtime";
import { eq, queryOnce, type Collection } from "@tanstack/db";
import type {
    BackendConnectionAdapterProvider,
    Connection,
    ConnectionController,
} from "@party-stack/connections";
import {
    createSQLiteBackendInstallation,
    createSQLiteOntologyBackendAdapter,
    createSQLiteOntologyRoute,
    type SQLiteDatabase,
} from "../index.js";

const conformanceIR: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
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
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
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
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
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
                        path: ["user"],
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["id"],
                            }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                        {
                            property: ["owner"],
                            value: o.Expression.valueReference({
                                path: ["owner"],
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
                    type: o.objectReference({
                        objectType: "Note",
                    }),
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
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
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
                            value: o.Expression.valueReference({
                                path: ["id"],
                            }),
                        },
                        {
                            property: ["attachment"],
                            value: o.Expression.valueReference({
                                path: ["attachment"],
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
                    type: o.objectReference({
                        objectType: "Note",
                    }),
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
    if (!condition) {
        throw new Error(message);
    }
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
        const note = await tx.query<
            | {
                  title: unknown;
              }
            | undefined
        >((query, objects) =>
            query
                .from({
                    note: objects.Note!,
                })
                .where(({ note }) => eq(note.id, args.note))
                .select(({ note }) => ({
                    title: note.title,
                }))
                .findOne()
        );
        return note?.title;
    },
    currentUser: ({ context }) => context.user,
} satisfies OntologyQueryFunctionRegistry;

function runSchemaCreation(database: SQLiteDatabase): void {
    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "schema",
    });
    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "schema",
    });

    const schema = database
        .prepare("SELECT value FROM party_stack_schema WHERE key = ?")
        .get("object:schema:Note");
    const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("party_stack_schema_Note");
    assert(schema !== undefined, "Schema metadata was not created.");
    assert(table !== undefined, "The object table was not created.");
}

async function runLegacyAttachmentMigration(database: SQLiteDatabase): Promise<void> {
    database.exec(`
        DROP TABLE IF EXISTS party_stack_attachments;
        CREATE TABLE party_stack_attachments (
            id TEXT PRIMARY KEY,
            bytes BLOB NOT NULL,
            type TEXT NOT NULL,
            name TEXT,
            size INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    database
        .prepare(
            `INSERT INTO party_stack_attachments (
                id, bytes, type, name, size, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("legacy-attachment", new TextEncoder().encode("legacy"), "text/plain", "legacy.txt", 6, 1, 1);
    const adapter = createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "legacy",
    });
    const row = database
        .prepare("SELECT ontology FROM party_stack_attachments WHERE id = ?")
        .get("legacy-attachment") as { ontology?: unknown } | undefined;
    assertEqual(row?.ontology, "legacy", "Legacy attachment rows were not assigned to the opening ontology.");
    const content = await adapter.attachments!.getAttachmentContent({
        id: "legacy-attachment",
    });
    assertEqual(await content.text(), "legacy", "Legacy attachment bytes were not readable after migration.");
}

async function runObjectQueriesAndActions(database: SQLiteDatabase): Promise<void> {
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database,
                name: "objects",
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
            {
                id: "note-1",
                title: "Hello",
                owner: "alice",
            },
            "The declarative action did not persist a queryable object."
        );
    } finally {
        await ontology.cleanup();
    }
}

async function runMutatorsAndQueryFunctions(database: SQLiteDatabase): Promise<void> {
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database,
                name: "handlers",
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
        const title = await ontology.queryFunctions.noteTitle!({
            note: "note-1",
        });
        const user = await ontology.queryFunctions.currentUser!({});
        assertEqual(title, "After", "The registered mutator or query function returned the wrong value.");
        assertEqual(user, "alice", "The query function did not receive canonical context.user.");
    } finally {
        await ontology.cleanup();
    }
}

async function runAttachments(database: SQLiteDatabase): Promise<void> {
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database,
                name: "attachments",
            }),
    });
    try {
        const created = await ontology.attachments.create(
            new Blob(["hello"], {
                type: "text/plain",
            }),
            {
                target: {
                    kind: "objectProperty",
                    objectType: "Asset",
                    property: "attachment",
                },
            }
        );
        await ontology.actions.createAsset!({
            id: "asset-1",
            attachment: created.attachment,
        });

        const metadata = await ontology.attachments.metadata(created.attachment);
        const content = await ontology.attachments.blob(created.attachment);
        assertEqual(metadata.size, 5, "Attachment metadata was not persisted.");
        assertEqual(metadata.type, "text/plain", "Attachment media type was not persisted.");
        assertEqual(await content.text(), "hello", "Attachment bytes were not persisted.");
    } finally {
        await ontology.cleanup();
    }
}

function runTransactionRollback(database: SQLiteDatabase): void {
    database.exec("CREATE TABLE party_stack_conformance_transaction (id TEXT PRIMARY KEY)");
    let threw = false;
    try {
        database.transaction(() => {
            database
                .prepare("INSERT INTO party_stack_conformance_transaction (id) VALUES (?)")
                .run("rolled-back");
            throw new Error("intentional rollback");
        })();
    } catch (error) {
        threw = error instanceof Error && error.message === "intentional rollback";
    }
    assert(threw, "The transaction did not surface its callback error.");
    const rows = database.prepare("SELECT id FROM party_stack_conformance_transaction").all();
    assertEqual(rows, [], "The transaction did not roll back its write.");
}

interface TestAuthentication {
    connect(userId: string): Promise<Connection<"active">>;
}

function createConnectionProvider(): BackendConnectionAdapterProvider<TestAuthentication> {
    return () => ({
        name: "sqlite-conformance",
        createAuthenticationClient(controller: ConnectionController) {
            return {
                async connect(userId) {
                    const connection = {
                        userId,
                        state: {
                            status: "active" as const,
                        },
                    };
                    await controller.connect({
                        connection,
                        session: {
                            disconnect: () => Promise.resolve(),
                        },
                    });
                    return connection;
                },
            };
        },
        restoreConnections: () => Promise.resolve([]),
    });
}

async function runInstallationIsolation(database: SQLiteDatabase): Promise<void> {
    const installation = await createSQLiteBackendInstallation({
        installationId: "sqlite-conformance",
        database,
        connections: createConnectionProvider(),
        runtime: createDefaultRuntime,
        routes: [
            createSQLiteOntologyRoute({
                ontologyId: "alpha",
                ir: conformanceIR,
                mutators,
                queryFunctions,
            }),
            createSQLiteOntologyRoute({
                ontologyId: "beta",
                ir: conformanceIR,
                mutators,
                queryFunctions,
            }),
        ],
        createContext: () => ({
            user: "spoofed",
        }),
    });
    try {
        await Promise.all([
            installation.authentication.connect("alice"),
            installation.authentication.connect("bob"),
        ]);
        const [aliceAlpha, bobAlpha, aliceBeta] = await Promise.all([
            installation.openOntology({
                userId: "alice",
                ontologyId: "alpha",
            }),
            installation.openOntology({
                userId: "bob",
                ontologyId: "alpha",
            }),
            installation.openOntology({
                userId: "alice",
                ontologyId: "beta",
            }),
        ]);

        assertEqual(
            aliceAlpha.context.user,
            "alice",
            "The installation allowed route context to spoof context.user."
        );
        assertEqual(
            bobAlpha.context.user,
            "bob",
            "Concurrent users did not receive distinct context.user values."
        );

        await aliceAlpha.actions.createNote!({
            id: "shared",
            title: "Alpha",
        });
        assertEqual(
            (await readObject(bobAlpha.objects.Note!, "shared"))?.title,
            "Alpha",
            "Users of one owned ontology did not share authoritative storage."
        );
        assertEqual(
            await readObject(aliceBeta.objects.Note!, "shared"),
            undefined,
            "Logical ontology IDs shared an object table."
        );
        const alphaAttachment = await aliceAlpha.attachments.create(
            new Blob(["alpha"], {
                type: "text/plain",
            }),
            {
                target: {
                    kind: "objectProperty",
                    objectType: "Asset",
                    property: "attachment",
                },
            }
        );
        await aliceAlpha.actions.createAsset!({
            id: "alpha-asset",
            attachment: alphaAttachment.attachment,
        });
        let attachmentWasIsolated = false;
        try {
            await aliceBeta.attachments.blob(alphaAttachment.attachment);
        } catch {
            attachmentWasIsolated = true;
        }
        assert(attachmentWasIsolated, "Logical ontology IDs shared attachment bytes.");

        await aliceBeta.actions.createNote!({
            id: "shared",
            title: "Beta",
        });
        assertEqual(
            (await readObject(bobAlpha.objects.Note!, "shared"))?.title,
            "Alpha",
            "Writing another logical ontology changed the first ontology."
        );

        await installation.disconnect("alice");
        assertEqual(
            installation.connections.get("alice")?.state.status,
            "inactive",
            "Disconnect did not retain an inactive connection."
        );
        await installation.forget("bob");
        assertEqual(
            installation.connections.get("bob"),
            undefined,
            "Forget did not remove connection state."
        );
    } finally {
        await installation.cleanup();
        await installation.cleanup();
    }

    const reloaded = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database,
                name: "alpha",
            }),
    });
    try {
        assertEqual(
            (await readObject(reloaded.objects.Note!, "shared"))?.title,
            "Alpha",
            "Connection cleanup or forget deleted owned ontology storage."
        );
    } finally {
        await reloaded.cleanup();
    }
}

export const sqliteOntologyConformanceCases = [
    {
        id: "schema",
        name: "creates schemas idempotently",
        run: runSchemaCreation,
    },
    {
        id: "objects-and-actions",
        name: "queries objects created by declarative actions",
        run: runObjectQueriesAndActions,
    },
    {
        id: "legacy-attachments",
        name: "migrates legacy attachment rows without version pragmas",
        run: runLegacyAttachmentMigration,
    },
    {
        id: "mutators-and-query-functions",
        name: "runs registered mutators and query functions with context.user",
        run: runMutatorsAndQueryFunctions,
    },
    {
        id: "attachments",
        name: "persists attachment metadata and bytes",
        run: runAttachments,
    },
    {
        id: "transaction-rollback",
        name: "rolls back synchronous transactions",
        run: runTransactionRollback,
    },
    {
        id: "installation-isolation",
        name: "separates connections from multiple logical ontologies",
        run: runInstallationIsolation,
    },
] as const;

export type SQLiteOntologyConformanceCaseId = (typeof sqliteOntologyConformanceCases)[number]["id"];

export async function runSQLiteOntologyConformanceCase(
    id: SQLiteOntologyConformanceCaseId,
    database: SQLiteDatabase
): Promise<void> {
    const test = sqliteOntologyConformanceCases.find((candidate) => candidate.id === id);
    assert(test !== undefined, `Unknown SQLite ontology conformance case "${id}".`);
    await test.run(database);
}

export { conformanceIR as sqliteOntologyConformanceIR };
