import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect, Result } from "effect";
import { byteSource } from "../blobs/bytes.js";
import {
    makeBlobStorage,
    collectByteBlob,
    type BlobBytesService,
    type BlobStorageService,
} from "../blobs/index.js";
import { Table, field } from "../model.js";
import { makeStorageModel } from "../ontology/model.js";
import { makeOntologyStorage } from "../ontology/storage.js";
import type { TablesService } from "../tables.js";

/** Exercise metadata/root atomicity against the driver's real transaction implementation. */
export const runBlobContract = Effect.fnUntraced(function* (tables: TablesService) {
    yield* Effect.scoped(
        Effect.gen(function* () {
            const values = new Map<string, Blob>();
            const bytes: BlobBytesService = {
                read: (key) =>
                    Effect.sync(() => {
                        const value = values.get(key);
                        return value === undefined ? undefined : byteSource(value);
                    }),
                write: (key, value) =>
                    collectByteBlob(value).pipe(
                        Effect.map((blob) => {
                            values.set(key, blob);
                        })
                    ),
                delete: (key) =>
                    Effect.promise(async () => {
                        values.delete(key);
                    }),
            };
            const blobs = yield* makeBlobStorage({ namespace: "blob-contract", tables, bytes });
            yield* blobs.stage("local", new Blob(["contract bytes"], { type: "text/plain" }));
            const failed = yield* Effect.result(
                tables.transaction((tx) =>
                    blobs
                        .in(tx)
                        .retain("rolled-back", ["local"])
                        .pipe(Effect.andThen(Effect.fail("expected rollback")))
                )
            );
            if (!Result.isFailure(failed)) throw new Error("Expected retention rollback");
            yield* tables.transaction((tx) => blobs.in(tx).retain("outbox", ["local"]));
            yield* blobs.bindRemoteId("local", "remote");
            if ((yield* blobs.collectGarbage({ olderThanMs: 0 })) !== 0)
                throw new Error("Outbox byte retention");
            yield* tables.transaction((tx) => blobs.in(tx).release("outbox"));
            if ((yield* blobs.collectGarbage({ olderThanMs: 0 })) !== 1)
                throw new Error("Retained roots must roll back with failed transactions");
            if (values.size !== 0) throw new Error("External generation deletion");
            if ((yield* blobs.metadata("remote"))?.id !== "local")
                throw new Error("Aliases survive eviction");
            yield* blobs.cache("remote", new Blob(["refetched"]));
            const value = yield* blobs.read("local");
            if (!value || (yield* Effect.promise(() => value.text())) !== "refetched")
                throw new Error("Alias cache refill");

            const ir: OntologyIR = {
                types: [],
                linkTypes: [],
                actionTypes: [],
                queryFunctionTypes: [],
                objectTypes: [
                    {
                        name: "Draft",
                        displayName: "Draft",
                        pluralDisplayName: "Drafts",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            {
                                name: "files",
                                displayName: "Files",
                                type: o.list({ elementType: o.attachment({}) }),
                            },
                        ],
                    },
                ],
            };
            const model = yield* makeStorageModel({ namespace: "blob-drafts", ir });
            const storage = makeOntologyStorage(model, tables, { blobs });
            const drafts = model.objects.Draft!;
            yield* blobs.stage("draft-file", new Blob(["draft"]));
            yield* storage.put(drafts, { id: "draft", files: [{ id: "draft-file" }] });
            if ((yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })) !== 1)
                throw new Error("Only the unreferenced remote cache may be collected");
            if (!(yield* blobs.metadata("draft-file"))) throw new Error("Draft identity retention");
            const rejected = yield* Effect.result(
                storage.transaction((tx) =>
                    tx.delete(drafts, "draft").pipe(Effect.andThen(Effect.fail("rejected delete")))
                )
            );
            if (!Result.isFailure(rejected)) throw new Error("Expected object rollback");
            if ((yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })) !== 0)
                throw new Error("Object and attachment roots must roll back together");
            yield* storage.put(drafts, { id: "draft", files: [] });
            if ((yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })) !== 1)
                throw new Error("Removing the last object reference releases staged bytes");
            if (yield* blobs.metadata("draft-file")) throw new Error("Orphan identity cleanup");

            const authoritative = yield* makeBlobStorage({
                namespace: "blob-authoritative",
                tables,
                bytes,
                mode: "authoritative",
            });
            const ownedModel = yield* makeStorageModel({ namespace: "blob-authoritative", ir });
            const owned = makeOntologyStorage(ownedModel, tables, { blobs: authoritative });
            const ownedDrafts = ownedModel.objects.Draft!;
            yield* authoritative.stage("owned-file", new Blob(["authoritative"]));
            yield* owned.put(ownedDrafts, { id: "owned", files: [{ id: "owned-file" }] });
            if ((yield* authoritative.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })) !== 0)
                throw new Error("Committed references must prevent authoritative collection");
            yield* owned.delete(ownedDrafts, "owned");
            if ((yield* authoritative.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })) !== 1)
                throw new Error("Unreferenced authoritative upload must be collectible");
            const unavailable = yield* Effect.result(
                owned.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put(ownedDrafts, { id: "also-rolled-back", files: [] });
                        yield* tx.put(ownedDrafts, { id: "late", files: [{ id: "owned-file" }] });
                    })
                )
            );
            if (!Result.isFailure(unavailable))
                throw new Error("An expired upload must reject the object transaction");
            if ((yield* owned.query(ownedDrafts)).length !== 0)
                throw new Error("Missing authoritative attachments must roll back every object write");
            if (yield* authoritative.metadata("owned-file"))
                throw new Error("Authoritative references must not recreate a collected placeholder");

            // Catching an object mutation failure must not commit its earlier root changes.
            const atomicIR: OntologyIR = {
                ...ir,
                objectTypes: ir.objectTypes.map((object) => ({
                    ...object,
                    properties: [
                        ...object.properties,
                        { name: "slug", displayName: "Slug", type: o.string({}) },
                    ],
                })),
            };
            const atomicModel = yield* makeStorageModel({ namespace: "blob-atomic", ir: atomicIR });
            const atomic = makeOntologyStorage(atomicModel, tables, { blobs: authoritative });
            const atomicDrafts = atomicModel.objects.Draft!;
            const marker = Table.make({ name: "blob-atomic-marker" });
            yield* atomic.ensureIndex(atomicDrafts, { name: "slug", field: field("slug"), unique: true });
            yield* authoritative.stage("atomic-old", new Blob(["keep"]));
            yield* authoritative.stage("atomic-new", new Blob(["orphan"]));
            yield* atomic.put(atomicDrafts, { id: "one", slug: "old", files: [{ id: "atomic-old" }] });
            yield* atomic.put(atomicDrafts, { id: "two", slug: "taken", files: [] });
            for (const outer of ["object", "tables"] as const) {
                for (const caught of [false, true]) {
                    for (const kind of ["unique", "attachment"] as const) {
                        const body = Effect.gen(function* () {
                            yield* tables.put(marker, "rolled-back", { caught, kind });
                            const write = atomic.put(atomicDrafts, {
                                id: "one",
                                slug: kind === "unique" ? "taken" : "available",
                                files: [{ id: kind === "unique" ? "atomic-new" : "missing-attachment" }],
                            });
                            if (caught) {
                                const result = yield* Effect.result(write);
                                if (!Result.isFailure(result))
                                    throw new Error("Expected object mutation failure");
                                if (kind === "unique" && result.failure.reason._tag !== "UniqueConstraint")
                                    throw new Error("Expected original unique constraint failure");
                                if (
                                    kind === "attachment" &&
                                    !(
                                        result.failure.reason._tag === "BlobStorageError" &&
                                        result.failure.reason.kind === "NotFound"
                                    )
                                )
                                    throw new Error(
                                        "Missing attachments must preserve their NotFound classification"
                                    );
                            } else yield* write;
                        });
                        const failedMutation =
                            outer === "object" ? atomic.withTransaction(body) : tables.withTransaction(body);
                        const result = yield* Effect.result(failedMutation);
                        if (!Result.isFailure(result))
                            throw new Error("A failed object mutation must prevent commit even when caught");
                        if (yield* tables.get(marker, "rolled-back"))
                            throw new Error(
                                "Object mutation failure must roll back the enclosing physical transaction"
                            );
                        const row = (yield* atomic.get(atomicDrafts, "one")) as
                            | { files: { id: string }[] }
                            | undefined;
                        if (row?.files[0]?.id !== "atomic-old")
                            throw new Error("Failed replacement must preserve the original row");
                    }
                }
            }
            if ((yield* authoritative.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })) !== 1)
                throw new Error("Only the failed replacement's orphaned bytes may be collected");
            if (!(yield* authoritative.metadata("atomic-old")))
                throw new Error("Failed replacement must preserve the original attachment root");
            // Force a yield inside a retention update. Concurrent logical puts may not
            // enter another retention update until the first row/root mutation finishes.
            yield* authoritative.stage("serial-a", new Blob(["A"]));
            yield* authoritative.stage("serial-b", new Blob(["B"]));
            const operations: string[] = [];
            const serialBlobs: BlobStorageService = {
                ...authoritative,
                in: (tx) => {
                    const retention = authoritative.in(tx);
                    return {
                        ...retention,
                        retain: (owner, ids, settings) =>
                            Effect.gen(function* () {
                                operations.push(`begin:${ids[0]}`);
                                yield* Effect.yieldNow;
                                yield* retention.retain(owner, ids, settings);
                                operations.push(`end:${ids[0]}`);
                            }),
                    };
                },
            };
            const serial = makeOntologyStorage(atomicModel, tables, { blobs: serialBlobs });
            const second = makeOntologyStorage(atomicModel, { ...tables }, { blobs: serialBlobs });
            yield* serial.transaction((tx) =>
                Effect.all(
                    [
                        tx.put(atomicDrafts, { id: "one", slug: "serial", files: [{ id: "serial-a" }] }),
                        second.put(atomicDrafts, { id: "one", slug: "serial", files: [{ id: "serial-b" }] }),
                    ],
                    { concurrency: 2 }
                )
            );
            if (
                operations.length !== 4 ||
                operations[1] !== operations[0]!.replace("begin:", "end:") ||
                operations[3] !== operations[2]!.replace("begin:", "end:")
            )
                throw new Error("Complete object mutations must serialize their retention updates");
            const final = (yield* atomic.get(atomicDrafts, "one")) as { files: { id: string }[] };
            yield* authoritative.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 });
            if (!(yield* authoritative.metadata(final.files[0]!.id)))
                throw new Error("Concurrent puts must retain the attachment from the committed row");
        })
    );
});
