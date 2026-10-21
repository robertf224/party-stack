import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore, SingleProcessCoordination, type RuntimeAdapter } from "@party-stack/runtime";
import { disposeRuntimeEffects } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { createBlobManager } from "./createBlobManager.js";

test("native blob facade loads metadata on demand and preserves remote aliases after eviction", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const bytes = new MemoryBlobBytesStore();
    const coordination = new SingleProcessCoordination({ scope: "native-blobs" });
    const runtime: RuntimeAdapter = {
        owner: "user",
        namespace: "native",
        tables: Effect.succeed(tables),
        coordination,
        blobBytes: bytes,
    };
    const read = vi.fn(() => Promise.resolve(new Blob(["refetched"], { type: "text/plain" })));
    const manager = createBlobManager({ runtime, remote: { read }, gcTime: Infinity });
    try {
        await manager.ready;
        expect(manager.collection.size).toBe(0);
        await manager.stage("local", new File(["staged"], "file.txt", { type: "text/plain" }));
        expect(manager.collection.size).toBe(0);
        expect(await manager.metadata("local")).toMatchObject({ id: "local", size: 6, name: "file.txt" });
        expect(read).not.toHaveBeenCalled();
        await manager.bindRemoteId("local", "remote");
        expect(await (await manager.read("remote")).text()).toBe("staged");
        const storage = await manager.storage!;
        await Effect.runPromise(storage.collectGarbage({ olderThanMs: 0 }));
        expect(bytes.blobs.size).toBe(0);
        expect(await (await manager.read("local")).text()).toBe("refetched");
        expect(read).toHaveBeenCalledWith("remote", expect.anything());
        const records = await queryOnce((q) => q.from({ blob: manager.collection }));
        expect(records).toMatchObject([{ id: "local", remoteId: "remote" }]);
        await Effect.runPromise(tables.transaction((tx) => storage.in(tx).retain("pending", ["local"])));
        bytes.blobs.clear();
        expect(await (await manager.read("local")).text()).toBe("refetched");
        expect(await manager.metadata("local")).toMatchObject({ name: "file.txt" });
        await Effect.runPromise(tables.transaction((tx) => storage.in(tx).release("pending")));
    } finally {
        await manager.cleanup();
        expect(manager.collection.status).toBe("cleaned-up");
        await disposeRuntimeEffects(runtime);
        await coordination.close();
    }
});

test("native blob cleanup aborts remote work and fences a late non-cancelable response", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const bytes = new MemoryBlobBytesStore();
    const coordination = new SingleProcessCoordination({ scope: "native-cancel" });
    const runtime: RuntimeAdapter = {
        owner: "user",
        namespace: "cancel",
        tables: Effect.succeed(tables),
        coordination,
        blobBytes: bytes,
    };
    let signal: AbortSignal | undefined;
    let finish!: (value: Blob) => void;
    const response = new Promise<Blob>((resolve) => {
        finish = resolve;
    });
    const manager = createBlobManager({
        runtime,
        gcTime: Infinity,
        remote: {
            read: (_id, options) => {
                signal = options?.signal;
                return response;
            },
        },
    });
    const pending = manager.read("remote").catch((error: unknown) => error);
    try {
        await vi.waitFor(() => expect(signal).toBeDefined());
        await manager.cleanup();
        expect(signal?.aborted).toBe(true);
        finish(new Blob(["late"]));
        await pending;
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(bytes.blobs.size).toBe(0);
    } finally {
        finish(new Blob());
        await manager.cleanup();
        await disposeRuntimeEffects(runtime);
        await coordination.close();
    }
});
