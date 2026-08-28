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
