import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { cloudflareCapacity } from "./capacity.js";

test("Cloudflare capacity reports a shared isolate limit and current SQLite usage without inventing free heap", async () => {
    let bytes = 4096;
    const capacity = cloudflareCapacity({
        sql: {
            get databaseSize() {
                return bytes;
            },
        },
        storageLimitBytes: 16384,
    });
    expect(await Effect.runPromise(capacity.memory)).toEqual({
        scope: "isolate",
        limitBytes: 128 * 1024 * 1024,
    });
    expect(await Effect.runPromise(capacity.storage)).toEqual({
        scope: "database",
        usedBytes: 4096,
        limitBytes: 16384,
        availableBytes: 12288,
    });
    bytes = 8192;
    expect((await Effect.runPromise(capacity.storage))?.availableBytes).toBe(8192);
    expect(await Effect.runPromise(cloudflareCapacity().storage)).toBeUndefined();
    expect(
        (await Effect.runPromise(cloudflareCapacity({ sql: { databaseSize: 4096 } }).storage))?.availableBytes
    ).toBeUndefined();
});
