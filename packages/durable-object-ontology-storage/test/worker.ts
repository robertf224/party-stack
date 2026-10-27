import { createLiveOntology, makeStorageOntologyBackend } from "@party-stack/ontology";
import {
    runSQLiteOntologyConformanceCase,
    sqliteOntologyConformanceIR,
    type SQLiteOntologyConformanceCaseId,
} from "@party-stack/ontology/testing/sqlite";
import { createSQLiteTestBackend } from "@party-stack/ontology/testing/sqliteBackend";
import { queryOnce } from "@tanstack/db";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
    makeDurableObjectOntologyStorage,
    makeR2Bytes,
    createDurableObjectSQLiteDatabase,
    destroyDurableObjectOntologyStorage,
    type DurableObjectSQLiteDatabase,
} from "../src/index.js";
import { r2Prefix } from "../src/r2Keys.js";
import { testBucket, withTestRuntime } from "./bindings.js";

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
            const binding = createSQLiteTestBackend({
                ir: sqliteOntologyConformanceIR,
                database: this.database,
                name: "sqlite",
            });
            const ontology = await createLiveOntology({
                ir: sqliteOntologyConformanceIR,
                backend: () => binding,
            });
            await ontology.cleanup();
        });
    }

    async runConformance(id: SQLiteOntologyConformanceCaseId): Promise<void> {
        await this.initialized;
        await runSQLiteOntologyConformanceCase(id, this.database);
    }

    withOntology<A>(
        inline: boolean,
        body: (ontology: Awaited<ReturnType<typeof createLiveOntology>>) => Promise<A>
    ) {
        const state = this.ctx;
        const bucket = this.env.BLOBS;
        return Effect.runPromise(
            withTestRuntime(
                Effect.scoped(
                    Effect.gen(function* () {
                        const storage = yield* makeDurableObjectOntologyStorage({
                            storage: state.storage,
                            ontologyId: "ontology",
                            bytes: inline
                                ? undefined
                                : yield* makeR2Bytes({
                                      bucket: testBucket(bucket),
                                      installationId: state.id.toString(),
                                      ontologyId: "ontology",
                                  }),
                        });
                        const backend = yield* makeStorageOntologyBackend({
                            ir: sqliteOntologyConformanceIR,
                            namespace: "ontology",
                            ...storage,
                        });
                        const ontology = yield* Effect.acquireRelease(
                            Effect.promise(() =>
                                createLiveOntology({
                                    ir: sqliteOntologyConformanceIR,
                                    backend: () => ({
                                        name: backend.name,
                                        open: () => Effect.succeed(backend),
                                    }),
                                    context: { user: "fixture" },
                                })
                            ),
                            (ontology) => Effect.promise(() => ontology.cleanup())
                        );
                        return yield* Effect.promise(() => body(ontology));
                    })
                ),
                bucket
            )
        );
    }

    createAndListNote(id?: string, title?: string): Promise<string[]> {
        return this.withOntology(true, async (ontology) => {
            if (id && title) await ontology.actions.createNote!({ id, title });
            await queryOnce((query) =>
                query.from({ note: ontology.objects.Note! }).select(({ note }) => note)
            );
            return [...ontology.objects.Note!.values()].map((note) => String(note.title));
        });
    }

    runR2Backend() {
        return this.withOntology(false, async (ontology) => {
            const created = await ontology.attachments.create(
                new Blob(["r2-content"], { type: "text/plain" }),
                {
                    target: { kind: "objectProperty", objectType: "Asset", property: "attachment" },
                }
            );
            await ontology.actions.createAsset!({ id: "asset-1", attachment: created.attachment });
            const blob = await ontology.attachments.blob(created.attachment);
            const inline = this.database
                .prepare("SELECT COUNT(*) AS count FROM party_blob_generations")
                .get() as {
                count: number;
            };
            return { content: await blob.text(), type: blob.type, sqlBytesAreExternal: inline.count === 0 };
        });
    }

    runInlineBackendWithoutR2() {
        return this.withOntology(true, async (ontology) => {
            const created = await ontology.attachments.create(new Blob(["inline"], { type: "text/plain" }), {
                target: { kind: "objectProperty", objectType: "Asset", property: "attachment" },
            });
            await ontology.actions.createAsset!({ id: "inline-asset", attachment: created.attachment });
            const inline = this.database
                .prepare("SELECT COUNT(*) AS count FROM party_blob_generations")
                .get() as {
                count: number;
            };
            return inline.count > 0;
        });
    }

    async runR2Destruction(): Promise<{
        quiesced: boolean;
        r2Empty: boolean;
    }> {
        await this.runR2Backend();
        let quiesced = false;
        const installationId = this.ctx.id.toString();
        await Effect.runPromise(
            withTestRuntime(
                destroyDurableObjectOntologyStorage({
                    storage: this.ctx.storage,
                    bucket: testBucket(this.env.BLOBS),
                    installationId,
                    quiesce: Effect.sync(() => {
                        quiesced = true;
                    }),
                }),
                this.env.BLOBS
            )
        );
        const listed = await this.env.BLOBS.list({
            prefix: await r2Prefix({ installationId, ontologyId: "ontology" }),
        });
        return {
            quiesced,
            r2Empty: listed.objects.length === 0,
        };
    }

    async destroyStorage(): Promise<void> {
        await Effect.runPromise(
            withTestRuntime(
                destroyDurableObjectOntologyStorage({
                    storage: this.ctx.storage,
                    bucket: testBucket(this.env.BLOBS),
                    installationId: this.ctx.id.toString(),
                    quiesce: Effect.void,
                }),
                this.env.BLOBS
            )
        );
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

export { AlchemyOntologyTest } from "./alchemy.js";
