import { Effect, Result } from "effect";
import { makeBlobStorage } from "../blobs/index.js";
import type { TablesService } from "../tables.js";

/** Exercise metadata/root atomicity against the driver's real transaction implementation. */
export const runBlobContract = Effect.fnUntraced(function* (tables: TablesService) {
    yield* Effect.scoped(
        Effect.gen(function* () {
            const values = new Map<string, Blob>();
            const blobs = yield* makeBlobStorage({
                namespace: "blob-contract",
                tables,
                bytes: {
                    read: (key) => Effect.promise(() => Promise.resolve(values.get(key))),
                    write: (key, value) =>
                        Effect.promise(async () => {
                            values.set(key, value);
                        }),
                    delete: (key) =>
                        Effect.promise(async () => {
                            values.delete(key);
                        }),
                },
            });
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
        })
    );
});
