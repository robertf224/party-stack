import { DurableObject } from "cloudflare:workers";
import { createLiveOntology } from "@party-stack/ontology";
import { createSQLiteOntologyBackendAdapter } from "@party-stack/sqlite-ontology";
import {
    runSQLiteOntologyConformanceCase,
    sqliteOntologyConformanceIR,
    type SQLiteOntologyConformanceCaseId,
} from "@party-stack/sqlite-ontology/testing";
import {
    createDurableObjectOntologyBackendAdapter,
    createDurableObjectSQLiteDatabase,
    destroyDurableObjectOntologyStorage,
    type DurableObjectSQLiteDatabase,
} from "../src/index.js";

interface TestEnvironment {
    BLOBS: R2Bucket;
}

export class DurableObjectOntologyTest extends DurableObject<TestEnvironment> {
    readonly database: DurableObjectSQLiteDatabase;
    readonly initialized: Promise<void>;

    constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
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

    async runR2Backend(): Promise<{
        content: string;
        type: string;
        sqlBytesAreExternal: boolean;
    }> {
        const ontology = await createLiveOntology({
            ir: sqliteOntologyConformanceIR,
            backend: () =>
                createDurableObjectOntologyBackendAdapter({
                    ir: sqliteOntologyConformanceIR,
                    storage: this.ctx.storage,
                    bucket: this.env.BLOBS,
                    installationId: "r2-test",
                    ontologyId: "primary",
                }),
        });
        try {
            const created = await ontology.attachments.create(
                new Blob(["r2-content"], {
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
            const blob = await ontology.attachments.blob(created.attachment);
            const row = this.database
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
                type: blob.type,
                sqlBytesAreExternal: row?.bytes === null && typeof row.storage_key === "string",
            };
        } finally {
            await ontology.cleanup();
        }
    }

    async runInlineBackendWithoutR2(): Promise<boolean> {
        const ontology = await createLiveOntology({
            ir: sqliteOntologyConformanceIR,
            backend: () =>
                createDurableObjectOntologyBackendAdapter({
                    ir: sqliteOntologyConformanceIR,
                    storage: this.ctx.storage,
                    installationId: "inline-test",
                    ontologyId: "inline",
                    attachmentStorage: "sqlite",
                }),
        });
        try {
            const created = await ontology.attachments.create(
                new Blob(["inline"], {
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
                id: "inline-asset",
                attachment: created.attachment,
            });
            const row = this.database
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
            return row?.bytes !== null && row?.storage_key === null;
        } finally {
            await ontology.cleanup();
        }
    }

    async runR2Destruction(): Promise<{
        quiesced: boolean;
        r2Empty: boolean;
    }> {
        await this.runR2Backend();
        let quiesced = false;
        await destroyDurableObjectOntologyStorage({
            storage: this.ctx.storage,
            bucket: this.env.BLOBS,
            installationId: "r2-test",
            quiesce: () => {
                quiesced = true;
                return Promise.resolve();
            },
        });
        const listed = await this.env.BLOBS.list();
        return {
            quiesced,
            r2Empty: listed.objects.length === 0,
        };
    }

    async destroyStorage(): Promise<void> {
        await destroyDurableObjectOntologyStorage({
            storage: this.ctx.storage,
            bucket: this.env.BLOBS,
            installationId: "r2-test",
            quiesce: () => Promise.resolve(),
        });
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
