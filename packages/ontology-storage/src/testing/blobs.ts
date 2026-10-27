import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect, Result } from "effect";
import { makeBlobStorage, collectByteBlob, type BlobBytesService } from "../blobs/index.js";
import { makeStorageModel } from "../ontology/model.js";
import { makeOntologyStorage } from "../ontology/storage.js";
import type { TablesService } from "../tables.js";

/** Exercise metadata/root atomicity against the driver's real transaction implementation. */
export const runBlobContract = Effect.fnUntraced(function* (tables: TablesService) {
    yield* Effect.scoped(
        Effect.gen(function* () {
            const values = new Map<string, Blob>();
            const bytes: BlobBytesService = {
                read: (key) => Effect.promise(() => Promise.resolve(values.get(key))),
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
            if ((yield* owned.loadSubset(ownedDrafts)).length !== 0)
                throw new Error("Missing authoritative attachments must roll back every object write");
            if (yield* authoritative.metadata("owned-file"))
                throw new Error("Authoritative references must not recreate a collected placeholder");
        })
    );
});
