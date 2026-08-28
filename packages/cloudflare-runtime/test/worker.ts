import { DurableObject } from "cloudflare:workers";
import { createBetterAuthConnectionAdapter, type BetterAuthConnectionClient } from "@party-stack/better-auth";
import {
    collectSQLiteAttachmentOrphans,
    createSQLiteBackendInstallation,
    createSQLiteOntologyBackendAdapter,
    createSQLiteOntologyRoute,
} from "@party-stack/sqlite-ontology";
import { sqliteOntologyConformanceIR } from "@party-stack/sqlite-ontology/testing";
import { createLocalCollection, type RuntimeAdapter } from "@party-stack/runtime";
import { createLiveOntology } from "@party-stack/ontology";
import { eq, queryOnce } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import {
    createCloudflareRuntimeHost,
    createCloudflareSQLiteBackendInstallation,
    createCloudflareSQLiteOntologyRoute,
    R2BlobBytesStore,
    type CloudflareRuntimeHost,
    type R2BucketLike,
} from "../src/index.js";
import { createDurableObjectSQLiteDatabase } from "@party-stack/cloudflare-sqlite-ontology";

interface TestEnvironment {
    BLOBS: R2Bucket;
}

interface RuntimeRecord {
    id: string;
    value: unknown;
}

function createSession(userId: string, index: number) {
    const now = new Date();
    return {
        session: {
            id: `session-${index}`,
            createdAt: now,
            updatedAt: now,
            userId,
            token: `token-${index}`,
            expiresAt: new Date(Date.now() + 3_600_000),
        },
        user: {
            id: userId,
            createdAt: now,
            updatedAt: now,
            email: `${userId}@example.com`,
            emailVerified: true,
            name: userId,
        },
    };
}

function createTestBetterAuthClient() {
    const sessions = [createSession("alice", 1), createSession("bob", 2)];
    const client = {
        signIn: {},
        multiSession: {
            listDeviceSessions: () =>
                Promise.resolve({
                    data: sessions,
                    error: null,
                }),
            revoke: ({ sessionToken }: { sessionToken: string }) => {
                const index = sessions.findIndex((entry) => entry.session.token === sessionToken);
                if (index >= 0) {
                    sessions.splice(index, 1);
                }
                return Promise.resolve({
                    data: { status: true },
                    error: null,
                });
            },
        },
        partyStack: {
            subscribe() {
                return () => {};
            },
        },
    } satisfies BetterAuthConnectionClient;
    return { client, sessions };
}

export class RuntimeTestDurableObject extends DurableObject<TestEnvironment> {
    private host: CloudflareRuntimeHost;

    constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.host = createCloudflareRuntimeHost({
            installationId: "runtime-test",
            storage: state.storage,
            bucket: environment.BLOBS,
        });
    }

    private async runtime(owner: string, namespace: string): Promise<RuntimeAdapter> {
        return this.host.runtime(owner, namespace);
    }

    async putRuntimeRecord(owner: string, namespace: string, id: string, value: unknown): Promise<void> {
        const runtime = await this.runtime(owner, namespace);
        const collection = createLocalCollection<RuntimeRecord, string>({
            name: "records",
            getKey: (record) => record.id,
            runtime,
            schemaVersion: 1,
        });
        try {
            await collection.preload();
            const existing = collection.get(id);
            const transaction = existing
                ? collection.update(id, { optimistic: false }, (draft) => {
                      draft.value = value;
                  })
                : collection.insert({ id, value }, { optimistic: false });
            await transaction.isPersisted.promise;
        } finally {
            await collection.cleanup();
            await runtime.cleanup?.();
        }
    }

    async getRuntimeRecord(owner: string, namespace: string, id: string): Promise<unknown> {
        const runtime = await this.runtime(owner, namespace);
        const collection = createLocalCollection<RuntimeRecord, string>({
            name: "records",
            getKey: (record) => record.id,
            runtime,
            schemaVersion: 1,
        });
        try {
            await collection.preload();
            return collection.get(id)?.value;
        } finally {
            await collection.cleanup();
            await runtime.cleanup?.();
        }
    }

    putTemporalRecord(): Promise<void> {
        return this.putRuntimeRecord("values", "temporal", "temporal", {
            instant: Temporal.Instant.from("2026-08-28T00:00:00Z"),
            date: Temporal.PlainDate.from("2026-08-28"),
        });
    }

    async temporalRecordSummary(): Promise<{
        instant: string;
        instantTag: string | undefined;
        date: string;
        dateTag: string | undefined;
    }> {
        const value = (await this.getRuntimeRecord("values", "temporal", "temporal")) as {
            instant: {
                toString(): string;
                [Symbol.toStringTag]?: string;
            };
            date: {
                toString(): string;
                [Symbol.toStringTag]?: string;
            };
        };
        return {
            instant: value.instant.toString(),
            instantTag: value.instant[Symbol.toStringTag],
            date: value.date.toString(),
            dateTag: value.date[Symbol.toStringTag],
        };
    }

    async cleanupRuntime(owner: string, namespace: string): Promise<void> {
        const runtime = await this.runtime(owner, namespace);
        await runtime.cleanup?.();
    }

    async setSecret(owner: string, namespace: string, key: string, value: string): Promise<void> {
        const runtime = await this.runtime(owner, namespace);
        try {
            await runtime.secrets?.set(key, value);
        } finally {
            await runtime.cleanup?.();
        }
    }

    async getSecret(owner: string, namespace: string, key: string): Promise<string | undefined> {
        const runtime = await this.runtime(owner, namespace);
        try {
            return runtime.secrets?.get(key);
        } finally {
            await runtime.cleanup?.();
        }
    }

    async destroyRuntime(owner: string, namespace: string): Promise<void> {
        const runtime = await this.runtime(owner, namespace);
        await runtime.destroy?.();
    }

    async destroyWithActivePeerIsBlocked(): Promise<boolean> {
        const first = await this.runtime("peer", "shared");
        let blocked = false;
        try {
            await this.runtime("peer", "shared");
        } catch {
            blocked = true;
        } finally {
            await first.destroy?.();
        }
        return blocked;
    }

    async writeBlob(
        owner: string,
        namespace: string,
        id: string,
        content: string,
        type: string
    ): Promise<void> {
        const runtime = await this.runtime(owner, namespace);
        try {
            await runtime.blobBytes.write(id, new Blob([content], { type }));
        } finally {
            await runtime.cleanup?.();
        }
    }

    async readBlob(owner: string, namespace: string, id: string): Promise<{ content: string; type: string }> {
        const runtime = await this.runtime(owner, namespace);
        try {
            const blob = await runtime.blobBytes.read(id);
            return {
                content: await blob.text(),
                type: blob.type,
            };
        } finally {
            await runtime.cleanup?.();
        }
    }

    async hasBlob(owner: string, namespace: string, id: string): Promise<boolean> {
        try {
            await this.readBlob(owner, namespace, id);
            return true;
        } catch {
            return false;
        }
    }

    async missingBlobError(): Promise<{
        name: string;
        message: string;
    }> {
        try {
            await this.readBlob("missing", "missing", "missing");
            throw new Error("Expected missing R2 bytes.");
        } catch (error) {
            return {
                name: error instanceof Error ? error.name : "unknown",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async runAuthoritativeR2Attachments(): Promise<{
        content: string;
        type: string;
        sqlBytesAreExternal: boolean;
        orphanCollected: boolean;
    }> {
        const database = createDurableObjectSQLiteDatabase(this.ctx.storage);
        const bytes = new R2BlobBytesStore({
            bucket: this.env.BLOBS,
            installationId: "authoritative-attachments",
            owner: "ontology",
            namespace: "host",
        });
        const ontology = await createLiveOntology({
            ir: sqliteOntologyConformanceIR,
            backend: () =>
                createSQLiteOntologyBackendAdapter({
                    ir: sqliteOntologyConformanceIR,
                    database,
                    name: "r2-authoritative",
                    attachmentStorage: {
                        external: {
                            bytes,
                            keyPrefix: "authoritative",
                        },
                    },
                }),
        });
        let result: {
            content: string;
            type: string;
            sqlBytesAreExternal: boolean;
        };
        try {
            const created = await ontology.attachments.create(
                new Blob(["r2-authoritative"], {
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
                id: "r2-asset",
                attachment: created.attachment,
            });
            const blob = await ontology.attachments.blob(created.attachment);
            const row = database
                .prepare(
                    `SELECT bytes, storage_key
                     FROM party_stack_attachments
                     WHERE id = ?`
                )
                .get(created.attachment.id) as
                | {
                      bytes: unknown;
                      storage_key: string | null;
                  }
                | undefined;
            result = {
                content: await blob.text(),
                type: blob.type,
                sqlBytesAreExternal: row?.bytes === null && typeof row.storage_key === "string",
            };
        } finally {
            await ontology.cleanup();
        }

        const failureNamespace = "r2_failure";
        const failureBytes = new R2BlobBytesStore({
            bucket: this.env.BLOBS,
            installationId: "authoritative-attachments",
            owner: "ontology",
            namespace: "failure",
        });
        const failingDatabase = {
            exec: (sql: string) => database.exec(sql),
            prepare(sql: string) {
                const statement = database.prepare(sql);
                return sql.includes(`INSERT INTO "party_stack_${failureNamespace}_Asset"`)
                    ? {
                          all: (...parameters: unknown[]) => statement.all(...parameters),
                          get: (...parameters: unknown[]) => statement.get(...parameters),
                          run: () => {
                              throw new Error("injected R2 SQL failure");
                          },
                      }
                    : statement;
            },
            transaction: (callback: () => void) => database.transaction(callback),
        };
        const failing = await createLiveOntology({
            ir: sqliteOntologyConformanceIR,
            backend: () =>
                createSQLiteOntologyBackendAdapter({
                    ir: sqliteOntologyConformanceIR,
                    database: failingDatabase,
                    name: "r2-failure",
                    sqlNamespace: failureNamespace,
                    attachmentStorage: {
                        external: {
                            bytes: failureBytes,
                            keyPrefix: "authoritative-failure",
                        },
                    },
                }),
        });
        let orphanCollected = false;
        try {
            const created = await failing.attachments.create(
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
            try {
                await failing.actions.createAsset!({
                    id: "failed-r2-asset",
                    attachment: created.attachment,
                });
            } catch {
                // Expected after the R2 put.
            }
            const deleted = await collectSQLiteAttachmentOrphans({
                database,
                bytes: failureBytes,
                ontology: failureNamespace,
            });
            orphanCollected = deleted === 1;
        } finally {
            await failing.cleanup();
        }
        return {
            ...result,
            orphanCollected,
        };
    }

    async runHighLevelFactory(): Promise<{
        content: string;
        sqlBytesAreExternal: boolean;
    }> {
        const installation = await createCloudflareSQLiteBackendInstallation({
            installationId: "high-level-factory",
            storage: this.ctx.storage,
            bucket: this.env.BLOBS,
            connections: () => ({
                name: "factory-test",
                createAuthenticationClient: (controller) => ({
                    async connect() {
                        const connection = {
                            userId: "factory-user",
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
                }),
                restoreConnections: () => Promise.resolve([]),
            }),
            routes: [
                createCloudflareSQLiteOntologyRoute({
                    ontologyId: "primary",
                    ir: sqliteOntologyConformanceIR,
                }),
            ],
        });
        try {
            await installation.authentication.connect();
            const ontology = await installation.openOntology({
                userId: "factory-user",
                ontologyId: "primary",
            });
            const created = await ontology.attachments.create(
                new Blob(["factory-r2"], {
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
                id: "factory-asset",
                attachment: created.attachment,
            });
            const blob = await ontology.attachments.blob(created.attachment);
            const row = installation.database
                .prepare(
                    `SELECT bytes, storage_key
                     FROM party_stack_attachments
                     WHERE id = ?`
                )
                .get(created.attachment.id) as
                | {
                      bytes: unknown;
                      storage_key: string | null;
                  }
                | undefined;
            return {
                content: await blob.text(),
                sqlBytesAreExternal: row?.bytes === null && typeof row.storage_key === "string",
            };
        } finally {
            await installation.cleanup();
        }
    }

    async runDestroyRetry(): Promise<{
        firstFailed: boolean;
        secondSucceeded: boolean;
    }> {
        let failList = true;
        const bucket: R2BucketLike = {
            put: (key, value, options) => this.env.BLOBS.put(key, value, options),
            get: (key) => this.env.BLOBS.get(key),
            delete: (keys) => this.env.BLOBS.delete(keys as string | string[]),
            list: (options) => {
                if (failList) {
                    failList = false;
                    return Promise.reject(new Error("transient R2 list failure"));
                }
                return this.env.BLOBS.list(options);
            },
        };
        const installation = await createCloudflareSQLiteBackendInstallation({
            installationId: "destroy-retry",
            storage: this.ctx.storage,
            bucket,
            connections: () => ({
                name: "destroy-retry",
                createAuthenticationClient: () => ({}),
                restoreConnections: () => Promise.resolve([]),
            }),
            routes: [
                createCloudflareSQLiteOntologyRoute({
                    ontologyId: "primary",
                    ir: sqliteOntologyConformanceIR,
                }),
            ],
        });
        let firstFailed = false;
        try {
            await installation.destroyInstallation();
        } catch (error) {
            firstFailed = error instanceof Error && error.message.includes("transient R2 list failure");
        }
        let secondSucceeded = false;
        try {
            await installation.destroyInstallation();
            secondSucceeded = true;
        } catch {
            secondSucceeded = false;
        }
        return {
            firstFailed,
            secondSucceeded,
        };
    }

    async runBetterAuthIntegration(): Promise<{
        usersSharedData: boolean;
        canonicalUsers: boolean;
        disconnectedState: string | undefined;
        forgotten: boolean;
        reconstructedState: string | undefined;
        authoritativeDataRetained: boolean;
    }> {
        const { client, sessions } = createTestBetterAuthClient();
        const database = createDurableObjectSQLiteDatabase(this.ctx.storage);
        const createInstallation = (host: CloudflareRuntimeHost) =>
            createSQLiteBackendInstallation({
                installationId: "better-auth-runtime-test",
                database,
                connections: createBetterAuthConnectionAdapter({ client }),
                runtime: host.runtime,
                routes: [
                    createSQLiteOntologyRoute({
                        ontologyId: "owned",
                        ir: sqliteOntologyConformanceIR,
                    }),
                ],
                createContext: () => ({
                    user: "spoofed",
                }),
            });
        const installation = await createInstallation(this.host);
        const alice = await installation.openOntology({
            userId: "alice",
            ontologyId: "owned",
        });
        const bob = await installation.openOntology({
            userId: "bob",
            ontologyId: "owned",
        });
        await alice.actions.createNote!({
            id: "auth-note",
            title: "shared",
        });
        await queryOnce((query) =>
            query
                .from({ note: bob.objects.Note! })
                .where(({ note }) => eq(note.id, "auth-note"))
                .select(({ note }) => note)
        );
        const usersSharedData = bob.objects.Note!.get("auth-note")?.title === "shared";
        const canonicalUsers = alice.context.user === "alice" && bob.context.user === "bob";

        await installation.disconnect("alice");
        const disconnectedState = installation.connections.get("alice")?.state.status;
        await installation.forget("bob");
        const forgotten = installation.connections.get("bob") === undefined;
        await installation.cleanup();

        sessions.splice(0, sessions.length);
        const reconstructedHost = createCloudflareRuntimeHost({
            installationId: "runtime-test",
            storage: this.ctx.storage,
            bucket: this.env.BLOBS,
        });
        const reconstructed = await createInstallation(reconstructedHost);
        const reconstructedState = reconstructed.connections.get("alice")?.state.status;
        const direct = await reconstructedHost.runtime("inspection", "inspection");
        const authoritative = await createSQLiteBackendInstallation({
            installationId: "inspection-installation",
            database,
            connections: () => ({
                name: "inspection",
                createAuthenticationClient: (controller) => ({
                    async connect() {
                        const connection = {
                            userId: "inspection",
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
                }),
                restoreConnections: () => Promise.resolve([]),
            }),
            runtime: reconstructedHost.runtime,
            routes: [
                createSQLiteOntologyRoute({
                    ontologyId: "owned",
                    ir: sqliteOntologyConformanceIR,
                }),
            ],
        });
        await authoritative.authentication.connect();
        const inspected = await authoritative.openOntology({
            userId: "inspection",
            ontologyId: "owned",
        });
        await queryOnce((query) =>
            query
                .from({
                    note: inspected.objects.Note!,
                })
                .where(({ note }) => eq(note.id, "auth-note"))
                .select(({ note }) => note)
        );
        const authoritativeDataRetained = inspected.objects.Note!.get("auth-note")?.title === "shared";
        await authoritative.cleanup();
        await reconstructed.cleanup();
        await reconstructedHost.cleanup();
        await direct.cleanup?.();
        return {
            usersSharedData,
            canonicalUsers,
            disconnectedState,
            forgotten,
            reconstructedState,
            authoritativeDataRetained,
        };
    }

    async destroyInstallation(): Promise<void> {
        await this.host.destroyInstallation();
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
