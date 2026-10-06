import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalCollection } from "@party-stack/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeRuntimeWithOptions } from "./createNodeRuntime.js";

interface Item {
    id: string;
    title: string;
}

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) =>
            rm(directory, {
                recursive: true,
                force: true,
            })
        )
    );
});

function createItems(runtime: Awaited<ReturnType<ReturnType<typeof createNodeRuntimeWithOptions>>>) {
    return createLocalCollection<Item, string>({
        name: "items",
        getKey: (item) => item.id,
        runtime,
        schemaVersion: 1,
    });
}

describe("createNodeRuntime", () => {
    it("reopens persisted SQLite collections", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const provider = createNodeRuntimeWithOptions({
            dataDirectory: directory,
        });
        const firstRuntime = await provider("owner", "namespace");
        const first = createItems(firstRuntime);
        await first.preload();
        await first.insert({
            id: "one",
            title: "Persisted",
        }).isPersisted.promise;
        await first.cleanup();
        await firstRuntime.cleanup?.();

        const secondRuntime = await provider("owner", "namespace");
        const second = createItems(secondRuntime);
        await second.preload();

        expect(second.get("one")).toMatchObject({
            id: "one",
            title: "Persisted",
        });
        await second.cleanup();
        await secondRuntime.destroy?.();
    });

    it("uses independent schema adapters on one database and preserves concurrent writes and schema checks", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const runtime = await createNodeRuntimeWithOptions({ dataDirectory: directory })("owner", "scoped");
        const open = (name: string, schemaVersion: number) => createLocalCollection<Item, string>({ name, schemaVersion, runtime, getKey: (item) => item.id });
        const first = open("first", 2);
        const second = open("second", 7);
        const third = open("third", 2);
        try {
            await Promise.all([first.preload(), second.preload(), third.preload()]);
            await Promise.all([first, second, third].map(async (collection, index) => {
                await collection.insert({ id: "saved", title: `Collection ${index}` }).isPersisted.promise;
            }));
            expect(first.get("saved")?.title).toBe("Collection 0");
            expect(second.get("saved")?.title).toBe("Collection 1");
            expect(third.get("saved")?.title).toBe("Collection 2");
            const resolve = runtime.persistence!.resolvePersistenceForCollection!;
            expect(resolve({ collectionId: first.id, mode: "sync-absent", schemaVersion: 2 }).adapter).not.toBe(resolve({ collectionId: third.id, mode: "sync-absent", schemaVersion: 2 }).adapter);
            await first.cleanup();
            const changed = open("first", 3);
            await expect(changed.preload()).rejects.toThrow(/schema/i);
            await changed.cleanup();
            const reopened = open("first", 2);
            await reopened.preload();
            expect(reopened.get("saved")?.title).toBe("Collection 0");
            await reopened.cleanup();
        } finally {
            await Promise.all([first.cleanup(), second.cleanup(), third.cleanup()]);
            await runtime.cleanup?.();
        }
    });

    it("isolates runtime namespaces", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const provider = createNodeRuntimeWithOptions({
            dataDirectory: directory,
        });
        const first = await provider("owner", "one");
        const second = await provider("owner", "two");

        await first.blobBytes.write("blob", new Blob(["first"]));
        await second.blobBytes.write("blob", new Blob(["second"]));

        await expect((await first.blobBytes.read("blob")).text()).resolves.toBe("first");
        await expect((await second.blobBytes.read("blob")).text()).resolves.toBe("second");
        await first.destroy?.();
        await second.destroy?.();
    });
});
