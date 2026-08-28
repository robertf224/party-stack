import {
    applyLensToObjectType,
    createLiveOntology,
    mapTargetPathToSourceWithLens,
    o,
    type Lens,
    type OntologyIR,
    type OntologyMutatorRegistry,
    type OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import { createDefaultRuntime, type BlobBytesStore } from "@party-stack/runtime";
import { eq, queryOnce, type Collection } from "@tanstack/db";
import type {
    BackendConnectionAdapterProvider,
    Connection,
    ConnectionController,
} from "@party-stack/connections";
import {
    collectSQLiteAttachmentOrphans,
    createSQLiteBackendInstallation,
    encodeLegacySQLiteIdentifierPart,
    encodeSQLiteNamespace,
    LegacySQLiteAttachmentMigrationRequiredError,
    SQLiteNamespaceCollisionError,
    createSQLiteOntologyBackendAdapter,
    createSQLiteOntologyRoute,
    UnsupportedSQLiteLensWriteError,
    type SQLiteAttachmentStorageOptions,
    type SQLiteDatabase,
    type SQLiteOntologyMigration,
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
        CREATE TABLE IF NOT EXISTS party_stack_migrations (
            namespace TEXT NOT NULL,
            version INTEGER NOT NULL,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            PRIMARY KEY (namespace, version)
        );
        DELETE FROM party_stack_migrations
        WHERE namespace = '__party_stack_attachments__';
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
    database
        .prepare(
            `INSERT INTO party_stack_attachments (
                id, bytes, type, name, size, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            "legacy-attachment-2",
            new TextEncoder().encode("legacy-2"),
            "text/plain",
            "legacy-2.txt",
            8,
            1,
            1
        );
    let requiredExplicitMapping = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database,
            name: "opened-first",
        });
    } catch (error) {
        requiredExplicitMapping = error instanceof LegacySQLiteAttachmentMigrationRequiredError;
    }
    assert(requiredExplicitMapping, "Legacy attachment migration did not require an explicit namespace.");
    const columnsAfterFailure = database
        .prepare(`PRAGMA table_info("party_stack_attachments")`)
        .all() as Array<{ name: string }>;
    assert(
        !columnsAfterFailure.some((column) => column.name === "ontology"),
        "Failed legacy attachment migration did not roll back."
    );
    let copiedRows = 0;
    const interruptedDatabase: SQLiteDatabase = {
        exec: (sql) => database.exec(sql),
        prepare(sql) {
            const statement = database.prepare(sql);
            if (sql.includes(`INSERT INTO "party_stack_attachments__migrating"`)) {
                return {
                    all: (...parameters) => statement.all(...parameters),
                    get: (...parameters) => statement.get(...parameters),
                    run: (...parameters) => {
                        copiedRows++;
                        if (copiedRows === 2) {
                            throw new Error("interrupted attachment migration");
                        }
                        return statement.run(...parameters);
                    },
                };
            }
            return statement;
        },
        transaction: (callback) => database.transaction(callback),
    };
    let interrupted = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database: interruptedDatabase,
            name: "legacy",
            attachmentStorage: {
                legacyAttachmentSqlNamespace: "legacy",
            },
        });
    } catch (error) {
        interrupted = error instanceof Error && error.message === "interrupted attachment migration";
    }
    assert(interrupted, "Interrupted legacy attachment migration did not fail.");
    assertEqual(
        database.prepare(`SELECT id FROM party_stack_attachments`).all().length,
        2,
        "Interrupted legacy attachment migration did not preserve source rows."
    );
    const adapter = createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "legacy",
        attachmentStorage: {
            legacyAttachmentSqlNamespace: "legacy",
        },
    });
    const row = database
        .prepare("SELECT ontology FROM party_stack_attachments WHERE id = ?")
        .get("legacy-attachment") as { ontology?: unknown } | undefined;
    assertEqual(row?.ontology, "legacy", "Legacy attachment rows were not assigned to the opening ontology.");
    const content = await adapter.attachments!.getAttachmentContent({
        id: "legacy-attachment",
    });
    assertEqual(await content.text(), "legacy", "Legacy attachment bytes were not readable after migration.");
    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "legacy",
        attachmentStorage: {
            legacyAttachmentSqlNamespace: "legacy",
        },
    });
    const other = createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "legacy-other",
    });
    let isolated = false;
    try {
        await other.attachments!.getAttachmentContent({
            id: "legacy-attachment",
        });
    } catch {
        isolated = true;
    }
    assert(isolated, "Explicitly migrated legacy attachment leaked into another ontology.");
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

async function runCollidingOntologyIds(database: SQLiteDatabase): Promise<void> {
    const installation = await createSQLiteBackendInstallation({
        installationId: "colliding-ontology-ids",
        database,
        connections: createConnectionProvider(),
        runtime: createDefaultRuntime,
        routes: [
            createSQLiteOntologyRoute({
                ontologyId: "a-b",
                ir: conformanceIR,
            }),
            createSQLiteOntologyRoute({
                ontologyId: "a_x2d_b",
                ir: conformanceIR,
            }),
        ],
    });
    try {
        await installation.authentication.connect("alice");
        const [punctuated, encodedLooking] = await Promise.all([
            installation.openOntology({
                userId: "alice",
                ontologyId: "a-b",
            }),
            installation.openOntology({
                userId: "alice",
                ontologyId: "a_x2d_b",
            }),
        ]);
        await punctuated.actions.createNote!({
            id: "same",
            title: "punctuated",
        });
        await encodedLooking.actions.createNote!({
            id: "same",
            title: "encoded-looking",
        });
        assertEqual(
            (await readObject(punctuated.objects.Note!, "same"))?.title,
            "punctuated",
            "Colliding ontology IDs shared the first SQL table."
        );
        assertEqual(
            (await readObject(encodedLooking.objects.Note!, "same"))?.title,
            "encoded-looking",
            "Colliding ontology IDs shared the second SQL table."
        );
    } finally {
        await installation.cleanup();
    }

    assert(
        encodeSQLiteNamespace("a-b") !== encodeSQLiteNamespace("a_x2d_b"),
        "Injective ontology namespace encoding collided."
    );
    assert(
        encodeSQLiteNamespace("\ud800") !== encodeSQLiteNamespace("\ufffd"),
        "SQLite namespace encoding collapsed distinct UTF-16 identifiers."
    );
    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "legacy-a-b",
    });
    let legacyCollisionDetected = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database,
            name: "legacy-a_x2d_b",
        });
    } catch (error) {
        legacyCollisionDetected = error instanceof SQLiteNamespaceCollisionError;
    }
    assert(legacyCollisionDetected, "Unsafe manually supplied legacy namespaces silently shared tables.");
    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "CaseSensitive",
    });
    let caseCollisionDetected = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database,
            name: "casesensitive",
        });
    } catch (error) {
        caseCollisionDetected = error instanceof SQLiteNamespaceCollisionError;
    }
    assert(
        caseCollisionDetected,
        "SQLite case-insensitive identifiers bypassed namespace collision detection."
    );
}

async function runDuplicateAttachmentIds(database: SQLiteDatabase): Promise<void> {
    const alphaNamespace = encodeLegacySQLiteIdentifierPart("alpha-attachments");
    const betaNamespace = encodeLegacySQLiteIdentifierPart("beta-attachments");
    database.exec(`
        CREATE TABLE IF NOT EXISTS party_stack_migrations (
            namespace TEXT NOT NULL,
            version INTEGER NOT NULL,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            PRIMARY KEY (namespace, version)
        );
        DELETE FROM party_stack_migrations
        WHERE namespace = '__party_stack_attachments__';
        DROP TABLE IF EXISTS party_stack_attachments;
        CREATE TABLE party_stack_attachments (
            id TEXT PRIMARY KEY,
            ontology TEXT NOT NULL,
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
                ontology, id, bytes, type, name, size,
                created_at, updated_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run("alpha-attachments", "shared-id", new TextEncoder().encode("alpha"), "text/plain", 5, 1, 1);
    database
        .prepare(
            `INSERT INTO party_stack_attachments (
                ontology, id, bytes, type, name, size,
                created_at, updated_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run(
            alphaNamespace,
            "legacy-collision",
            new TextEncoder().encode("collision"),
            "text/plain",
            9,
            1,
            1
        );
    let ownerCollisionDetected = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database,
            name: "alpha-attachments",
        });
    } catch (error) {
        ownerCollisionDetected = error instanceof SQLiteNamespaceCollisionError;
    }
    assert(ownerCollisionDetected, "Legacy attachment owners collapsed into one physical namespace.");
    database
        .prepare(
            `DELETE FROM party_stack_attachments
             WHERE id = ?`
        )
        .run("legacy-collision");
    const alpha = createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "alpha-attachments",
    });
    const beta = createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "beta-attachments",
    });
    const insert = database.prepare(`
        INSERT INTO party_stack_attachments (
            ontology, id, bytes, storage_key, type, name, size,
            created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    `);
    insert.run(betaNamespace, "shared-id", new TextEncoder().encode("beta"), "text/plain", 4, 1, 1);
    const [alphaBlob, betaBlob] = await Promise.all([
        alpha.attachments!.getAttachmentContent({
            id: "shared-id",
        }),
        beta.attachments!.getAttachmentContent({
            id: "shared-id",
        }),
    ]);
    assertEqual(await alphaBlob.text(), "alpha", "The first ontology lost a duplicate attachment ID.");
    assertEqual(await betaBlob.text(), "beta", "The second ontology lost a duplicate attachment ID.");
}

class ConformanceBlobBytesStore implements BlobBytesStore {
    readonly blobs = new Map<string, Blob>();

    write(id: string, blob: Blob): Promise<void> {
        this.blobs.set(id, blob);
        return Promise.resolve();
    }

    read(id: string): Promise<Blob> {
        const blob = this.blobs.get(id);
        return blob
            ? Promise.resolve(blob)
            : Promise.reject(new Error(`External attachment "${id}" not found.`));
    }

    delete(id: string): Promise<void> {
        this.blobs.delete(id);
        return Promise.resolve();
    }
}

async function runExternalAttachments(database: SQLiteDatabase): Promise<void> {
    const bytes = new ConformanceBlobBytesStore();
    const storage = {
        external: {
            bytes,
            keyPrefix: "conformance-external",
        },
    } satisfies SQLiteAttachmentStorageOptions;
    const ontology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database,
                name: "external",
                attachmentStorage: storage,
            }),
    });
    try {
        const created = await ontology.attachments.create(
            new Blob(["external"], {
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
            id: "external-asset",
            attachment: created.attachment,
        });
        const row = database
            .prepare(
                `SELECT bytes, storage_key
                 FROM party_stack_attachments
                 WHERE ontology = ? AND id = ?`
            )
            .get("external", created.attachment.id) as
            | {
                  bytes: unknown;
                  storage_key: string | null;
              }
            | undefined;
        assert(
            row?.bytes === null && typeof row.storage_key === "string",
            "External attachment metadata did not reference external bytes."
        );
        assertEqual(
            await (await ontology.attachments.blob(created.attachment)).text(),
            "external",
            "External authoritative attachment bytes were not readable."
        );
    } finally {
        await ontology.cleanup();
    }

    const failureNamespace = "external_failure";
    const failingDatabase: SQLiteDatabase = {
        exec: (sql) => database.exec(sql),
        prepare(sql) {
            const statement = database.prepare(sql);
            if (sql.includes(`INSERT INTO "party_stack_${failureNamespace}_Asset"`)) {
                return {
                    all: (...parameters) => statement.all(...parameters),
                    get: (...parameters) => statement.get(...parameters),
                    run: () => {
                        throw new Error("injected SQL failure");
                    },
                };
            }
            return statement;
        },
        transaction: (callback) => database.transaction(callback),
    };
    const failingOntology = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database: failingDatabase,
                name: "external-failure",
                sqlNamespace: failureNamespace,
                attachmentStorage: storage,
            }),
    });
    try {
        const created = await failingOntology.attachments.create(
            new Blob(["orphan"], {
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
        let failed = false;
        try {
            await failingOntology.actions.createAsset!({
                id: "failed-asset",
                attachment: created.attachment,
            });
        } catch (error) {
            failed = error instanceof Error && error.message === "injected SQL failure";
        }
        assert(failed, "Injected SQL failure did not reject the attachment action.");
        assert(
            database
                .prepare(
                    `SELECT id
                     FROM "party_stack_external_failure_Asset"
                     WHERE id = ?`
                )
                .get("failed-asset") === undefined,
            "Object reference committed after its required attachment SQL write failed."
        );
        const orphan = database
            .prepare(
                `SELECT storage_key
                 FROM party_stack_attachment_orphans
                 WHERE ontology = ?`
            )
            .get(failureNamespace) as { storage_key: string } | undefined;
        assert(
            orphan && bytes.blobs.has(orphan.storage_key),
            "SQL failure did not journal the uploaded orphan."
        );
        const deleted = await collectSQLiteAttachmentOrphans({
            database,
            bytes,
            ontology: failureNamespace,
        });
        assertEqual(deleted, 1, "Orphan collection did not delete the failed external upload.");
        assert(!bytes.blobs.has(orphan.storage_key), "Orphan bytes remained after garbage collection.");
    } finally {
        await failingOntology.cleanup();
    }
}

async function runSchemaMigrations(database: SQLiteDatabase): Promise<void> {
    let asyncMigrationRan = false;
    let asyncMigrationRejected = false;
    const asyncUp = (async () => {
        await Promise.resolve();
        asyncMigrationRan = true;
    }) as unknown as SQLiteOntologyMigration["up"];
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database,
            name: "async-migration",
            sqlNamespace: "async_migration",
            storageVersion: 1,
            migrations: [
                {
                    version: 1,
                    up: asyncUp,
                },
            ],
        });
    } catch (error) {
        asyncMigrationRejected = error instanceof Error && error.message.includes("must be synchronous");
    }
    assert(
        asyncMigrationRejected && !asyncMigrationRan,
        "Asynchronous SQLite migration was executed or recorded."
    );
    let deferredWriteSucceeded = false;
    const promiseReturningUp = ((context: Parameters<SQLiteOntologyMigration["up"]>[0]) =>
        Promise.resolve().then(() => {
            context.database.exec(`CREATE TABLE forbidden_deferred_migration (id TEXT)`);
            deferredWriteSucceeded = true;
        })) as unknown as SQLiteOntologyMigration["up"];
    let promiseReturningRejected = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: conformanceIR,
            database,
            name: "promise-migration",
            sqlNamespace: "promise_migration",
            storageVersion: 1,
            migrations: [
                {
                    version: 1,
                    up: promiseReturningUp,
                },
            ],
        });
    } catch (error) {
        promiseReturningRejected = error instanceof Error && error.message.includes("must be synchronous");
    }
    await Promise.resolve();
    assert(
        promiseReturningRejected && !deferredWriteSucceeded,
        "Promise-returning SQLite migration escaped its transaction guard."
    );

    const namespace = "schema_upgrade";
    const migrations: SQLiteOntologyMigration[] = [
        {
            version: 1,
            name: "initial-schema",
            up: () => {},
        },
    ];
    const original = await createLiveOntology({
        ir: conformanceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: conformanceIR,
                database,
                name: "schema-upgrade",
                sqlNamespace: namespace,
                storageVersion: 1,
                migrations,
            }),
        context: { user: "alice" },
    });
    await original.actions.createNote!({
        id: "upgrade-note",
        title: "Before upgrade",
    });
    await original.cleanup();

    const upgradedIR = structuredClone(conformanceIR);
    const noteType = upgradedIR.objectTypes.find((objectType) => objectType.name === "Note");
    assert(noteType, "Conformance Note type is missing.");
    noteType.properties.push({
        name: "status",
        displayName: "Status",
        type: o.string({}),
    });

    let failMigration = true;
    const upgradeMigration: SQLiteOntologyMigration = {
        version: 2,
        name: "add-note-status",
        up(context) {
            const table = context.objectTableName("Note");
            const rows = context.database.prepare(`SELECT id, data FROM "${table}"`).all() as Array<{
                id: string;
                data: string;
            }>;
            const update = context.database.prepare(
                `UPDATE "${table}"
                         SET data = ?
                         WHERE id = ?`
            );
            for (const row of rows) {
                update.run(
                    JSON.stringify({
                        ...JSON.parse(row.data),
                        status: "migrated",
                    }),
                    row.id
                );
            }
            if (failMigration) {
                failMigration = false;
                throw new Error("injected migration failure");
            }
        },
    };
    let failed = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: upgradedIR,
            database,
            name: "schema-upgrade",
            sqlNamespace: namespace,
            storageVersion: 2,
            migrations: [...migrations, upgradeMigration],
        });
    } catch (error) {
        failed = error instanceof Error && error.message === "injected migration failure";
    }
    assert(failed, "Failed schema migration did not reject initialization.");
    const rolledBack = database
        .prepare(
            `SELECT data
             FROM "party_stack_schema_upgrade_Note"
             WHERE id = ?`
        )
        .get("upgrade-note") as { data: string } | undefined;
    assert(
        rolledBack && !("status" in JSON.parse(rolledBack.data)),
        "Failed schema migration did not roll back transformed data."
    );
    const migrationVersion = database
        .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM party_stack_migrations
             WHERE namespace = ?`
        )
        .get(namespace) as { version: number };
    assertEqual(Number(migrationVersion.version), 1, "Failed schema migration was recorded.");

    const upgraded = await createLiveOntology({
        ir: upgradedIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: upgradedIR,
                database,
                name: "schema-upgrade",
                sqlNamespace: namespace,
                storageVersion: 2,
                migrations: [...migrations, upgradeMigration],
            }),
    });
    try {
        assertEqual(
            (await readObject(upgraded.objects.Note!, "upgrade-note"))?.status,
            "migrated",
            "Compatible schema migration did not preserve and transform existing data."
        );
    } finally {
        await upgraded.cleanup();
    }

    let freshMigrationSawTable = false;
    createSQLiteOntologyBackendAdapter({
        ir: upgradedIR,
        database,
        name: "fresh-latest",
        sqlNamespace: "fresh_latest",
        storageVersion: 2,
        migrations: [
            {
                version: 1,
                up(context) {
                    context.database.prepare(`SELECT id FROM "${context.objectTableName("Note")}"`).all();
                    freshMigrationSawTable = true;
                },
            },
            {
                version: 2,
                up: () => {},
            },
        ],
    });
    assert(
        freshMigrationSawTable,
        "Fresh latest-version migration could not access its bootstrapped object table."
    );
    database.exec(`
        CREATE TABLE "party_stack_repair_physical_Note" (
            legacy_id TEXT PRIMARY KEY,
            id TEXT,
            data TEXT NOT NULL
        )
    `);
    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "repair-physical",
        sqlNamespace: "repair_physical",
        storageVersion: 1,
        migrations: [
            {
                version: 1,
                up(context) {
                    const table = context.objectTableName("Note");
                    context.database.exec(`
                        ALTER TABLE "${table}" RENAME TO "${table}_old";
                        CREATE TABLE "${table}" (
                            id TEXT PRIMARY KEY,
                            data TEXT NOT NULL
                        );
                        INSERT INTO "${table}" (id, data)
                        SELECT id, data FROM "${table}_old";
                        DROP TABLE "${table}_old"
                    `);
                },
            },
        ],
    });

    createSQLiteOntologyBackendAdapter({
        ir: conformanceIR,
        database,
        name: "older-ontology",
        sqlNamespace: "older_ontology",
        storageVersion: 1,
        migrations,
    });
    const versions = database
        .prepare(
            `SELECT namespace, MAX(version) AS version
             FROM party_stack_migrations
             WHERE namespace IN (?, ?)
             GROUP BY namespace
             ORDER BY namespace`
        )
        .all("older_ontology", namespace) as Array<{
        namespace: string;
        version: number;
    }>;
    assertEqual(
        versions.map((row) => [row.namespace, Number(row.version)]),
        [
            ["older_ontology", 1],
            [namespace, 2],
        ],
        "Logical ontologies did not retain independent storage versions."
    );
}

async function runLensConformance(database: SQLiteDatabase): Promise<void> {
    const sourceUser = {
        name: "SourceUser",
        displayName: "Source user",
        pluralDisplayName: "Source users",
        primaryKey: "id",
        properties: [
            {
                name: "id",
                displayName: "ID",
                type: o.string({}),
            },
            {
                name: "name",
                displayName: "Name",
                type: o.string({}),
            },
            {
                name: "profilePicture",
                displayName: "Profile picture",
                type: o.optional({
                    type: o.attachment({}),
                }),
            },
            {
                name: "admin",
                displayName: "Admin",
                type: o.boolean({}),
            },
        ],
    } satisfies OntologyIR["objectTypes"][number];
    const lens: Lens = {
        operations: [
            o.LensOp.move({
                from: ["profilePicture"],
                to: ["avatar"],
            }),
            o.LensOp.select({
                properties: ["id", "name", "avatar"],
            }),
        ],
    };
    const targetUser = applyLensToObjectType(sourceUser, lens, { name: "User" });
    const sourceIR: OntologyIR = {
        types: [],
        objectTypes: [sourceUser],
        linkTypes: [],
        queryFunctionTypes: [],
        actionTypes: [
            {
                name: "createSourceUser",
                displayName: "Create source user",
                parameters: [
                    {
                        name: "id",
                        displayName: "ID",
                        type: o.string({}),
                    },
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                    },
                ],
                logic: [
                    o.ActionLogicStep.createObject({
                        objectType: "SourceUser",
                        values: [
                            {
                                property: ["id"],
                                value: o.Expression.valueReference({
                                    path: ["id"],
                                }),
                            },
                            {
                                property: ["name"],
                                value: o.Expression.valueReference({
                                    path: ["name"],
                                }),
                            },
                            {
                                property: ["profilePicture"],
                                value: o.Expression.literal({
                                    type: o.optional({
                                        type: o.attachment({}),
                                    }),
                                    value: {
                                        id: "avatar-1",
                                    },
                                }),
                            },
                            {
                                property: ["admin"],
                                value: o.Expression.literal({
                                    type: o.boolean({}),
                                    value: true,
                                }),
                            },
                        ],
                    }),
                ],
            },
        ],
    };
    const targetIR: OntologyIR = {
        types: [],
        objectTypes: [targetUser],
        linkTypes: [],
        queryFunctionTypes: [],
        actionTypes: [
            {
                name: "renameUser",
                displayName: "Rename user",
                parameters: [
                    {
                        name: "user",
                        displayName: "User",
                        type: o.objectReference({
                            objectType: "User",
                        }),
                    },
                    {
                        name: "name",
                        displayName: "Name",
                        type: o.string({}),
                    },
                ],
                logic: [
                    o.ActionLogicStep.updateObject({
                        object: {
                            path: ["user"],
                        },
                        values: [
                            {
                                property: ["name"],
                                value: o.Expression.valueReference({
                                    path: ["name"],
                                }),
                            },
                        ],
                    }),
                ],
            },
        ],
    };
    let unknownTargetRejected = false;
    try {
        createSQLiteOntologyBackendAdapter({
            ir: targetIR,
            database,
            name: "invalid-lens-target",
            sqlNamespace: "invalid_lens_target",
            lensBindings: [
                {
                    targetObjectType: "MissingUser",
                    sourceIR,
                    sourceObjectType: "SourceUser",
                    lens,
                },
            ],
        });
    } catch (error) {
        unknownTargetRejected = error instanceof Error && error.message.includes("unknown object type");
    }
    assert(unknownTargetRejected, "Unknown SQLite lens binding target was silently ignored.");
    const namespace = "lens_conformance";
    const source = await createLiveOntology({
        ir: sourceIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: sourceIR,
                database,
                name: "lens-conformance",
                sqlNamespace: namespace,
            }),
    });
    await source.actions.createSourceUser!({
        id: "user-1",
        name: "Ada",
    });
    await source.cleanup();

    const target = await createLiveOntology({
        ir: targetIR,
        backend: () =>
            createSQLiteOntologyBackendAdapter({
                ir: targetIR,
                database,
                name: "lens-conformance",
                sqlNamespace: namespace,
                lensBindings: [
                    {
                        targetObjectType: "User",
                        sourceIR,
                        sourceObjectType: "SourceUser",
                        lens,
                    },
                ],
            }),
    });
    try {
        assertEqual(
            target.ir.objectTypes[0],
            targetUser,
            "Lens schema projection was not exposed by the target ontology."
        );
        const projected = await readObject(target.objects.User!, "user-1");
        assertEqual(
            projected && {
                id: projected.id,
                name: projected.name,
                avatarId: (projected.avatar as { id?: unknown } | undefined)?.id,
                admin: projected.admin,
            },
            {
                id: "user-1",
                name: "Ada",
                avatarId: "avatar-1",
                admin: undefined,
            },
            "Lens runtime object projection was incorrect."
        );
        assertEqual(
            mapTargetPathToSourceWithLens(["avatar", "id"], lens),
            ["profilePicture", "id"],
            "Lens target query path did not map to its source path."
        );
        let unsupportedPathFailed = false;
        try {
            mapTargetPathToSourceWithLens(["admin"], lens);
        } catch {
            unsupportedPathFailed = true;
        }
        assert(unsupportedPathFailed, "Lens accepted a target query path for a selected-out source field.");
        const stored = database
            .prepare(
                `SELECT data
                 FROM "party_stack_lens_conformance_SourceUser"
                 WHERE id = ?`
            )
            .get("user-1") as { data: string } | undefined;
        const storedValue = stored ? (JSON.parse(stored.data) as Record<string, unknown>) : undefined;
        assert(storedValue?.admin === true, "Reading through a lens changed older source data.");
        let writeFailed = false;
        try {
            await target.actions.renameUser!({
                user: "user-1",
                name: "Changed",
            });
        } catch (error) {
            writeFailed = error instanceof UnsupportedSQLiteLensWriteError;
        }
        assert(writeFailed, "Unsupported reverse lens write did not fail explicitly.");
    } finally {
        await target.cleanup();
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
    {
        id: "colliding-ontology-ids",
        name: "isolates deliberately colliding ontology IDs",
        run: runCollidingOntologyIds,
    },
    {
        id: "duplicate-attachment-ids",
        name: "stores the same attachment ID in two ontologies",
        run: runDuplicateAttachmentIds,
    },
    {
        id: "external-attachments",
        name: "uses external attachment bytes with orphan recovery",
        run: runExternalAttachments,
    },
    {
        id: "schema-migrations",
        name: "applies and retries namespace-scoped schema migrations",
        run: runSchemaMigrations,
    },
    {
        id: "lenses",
        name: "projects lens-bound SQLite objects and rejects reverse writes",
        run: runLensConformance,
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
