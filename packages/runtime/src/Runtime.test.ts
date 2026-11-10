import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { MemoryBlobBytesStore } from "./memory/MemoryBlobBytesStore.js";
import { Runtime } from "./Runtime.js";
import { RuntimePartition } from "./RuntimePartition.js";

test("Runtime assembles acquired services without wrapping bytes or their failures", async () => {
    const failure = new Error("driver failure");
    const driver = new MemoryBlobBytesStore();
    const bytes = { read: () => Effect.fail(failure), write: driver.write, delete: driver.delete };
    const tables = await Effect.runPromise(Memory.make());
    const runtime = await Effect.runPromise(
        Runtime.make({ tables, blobBytes: bytes }).pipe(
            Effect.provideService(RuntimePartition, { owner: "alice", namespace: "notes" })
        )
    );
    expect(runtime.tables).toBe(tables);
    expect(runtime.bytes).toBe(bytes);
    expect(runtime.owner).toBe("alice");
    expect(await Effect.runPromise(Effect.result(runtime.bytes.read("one")))).toMatchObject({
        _tag: "Failure",
        failure,
    });
});
