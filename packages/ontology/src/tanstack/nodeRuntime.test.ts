import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { make as makeNodeRuntime } from "@party-stack/node-runtime";
import { Table } from "@party-stack/ontology-storage/tables";
import { collectByteBlob } from "@party-stack/runtime";
import { Runtime, RuntimePartition } from "@party-stack/runtime";
import { acquireRuntime } from "@party-stack/runtime/testing";
import { runtimeFixtureContext } from "@party-stack/runtime/testing";
import { queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createLocalCollection } from "./createLocalCollection.js";

const createNodeRuntimeWithOptions =
    (options: Parameters<typeof makeNodeRuntime>[0]) => (owner: string, namespace: string) =>
        makeNodeRuntime(options).pipe(Effect.provideService(RuntimePartition, { owner, namespace }));

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

function createItems(runtime: Awaited<ReturnType<typeof acquireRuntime>>) {
    return createLocalCollection<Item, string>({
        name: "items",
        getKey: (item) => item.id,
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        schemaVersion: 1,
    });
}

describe("createNodeRuntime", () => {
    it("reopens nested Temporal rows and private metadata through owned storage", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-temporal-"));
        directories.push(directory);
        const provider = createNodeRuntimeWithOptions({ dataDirectory: directory });
        const instant = Temporal.Instant.from("2026-10-07T12:00:00.123456789Z");
        const date = Temporal.PlainDate.from("2026-10-07");
        const open = (runtime: Awaited<ReturnType<typeof acquireRuntime>>) =>
            createLocalCollection<
                { id: string; instant: Temporal.Instant; nested: { dates: Temporal.PlainDate[] } },
                string
            >({
                name: "temporal",
                getKey: (item) => item.id,
                runtime: runtimeFixtureContext(runtime).service,
                scope: runtimeFixtureContext(runtime).scope,
                schemaVersion: 1,
            });
        const firstRuntime = await acquireRuntime(provider("owner", "temporal"));
        const first = open(firstRuntime);
        const metadata = Table.make<{ cursor: Temporal.Instant; date: Temporal.PlainDate }>({
            name: "test-runtime-metadata",
        });
        try {
            await queryOnce((q) => q.from({ row: first }));
            await first.insert({ id: "one", instant, nested: { dates: [date] } }).isPersisted.promise;
            await first.cleanup();
            const storage = await runtimeFixtureContext(firstRuntime).runtime.runPromise(Runtime);
            await runtimeFixtureContext(firstRuntime).runtime.runPromise(
                storage.tables.put(metadata, "head", { cursor: instant, date })
            );
        } finally {
            await first.cleanup();
            await firstRuntime.cleanup?.();
        }

        const secondRuntime = await acquireRuntime(provider("owner", "temporal"));
        const second = open(secondRuntime);
        try {
            await queryOnce((q) => q.from({ row: second }));
            expect(second.get("one")?.instant).toBeInstanceOf(Temporal.Instant);
            expect(second.get("one")?.instant.epochNanoseconds).toBe(instant.epochNanoseconds);
            expect(second.get("one")?.nested.dates[0]).toBeInstanceOf(Temporal.PlainDate);
            expect(second.get("one")?.nested.dates[0]?.toString()).toBe(date.toString());
            const storage = await runtimeFixtureContext(secondRuntime).runtime.runPromise(Runtime);
            const restored = await runtimeFixtureContext(secondRuntime).runtime.runPromise(
                storage.tables.get(metadata, "head")
            );
            expect(restored?.cursor.epochNanoseconds).toBe(instant.epochNanoseconds);
            expect(restored?.date.toString()).toBe(date.toString());
        } finally {
            await second.cleanup();
            await secondRuntime.cleanup?.();
        }
    });

    it("reopens persisted SQLite collections", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const provider = createNodeRuntimeWithOptions({
            dataDirectory: directory,
        });
        const firstRuntime = await acquireRuntime(provider("owner", "namespace"));
        const first = createItems(firstRuntime);
        await queryOnce((q) => q.from({ row: first }));
        await first.insert({
            id: "one",
            title: "Persisted",
        }).isPersisted.promise;
        await first.cleanup();
        await firstRuntime.cleanup?.();

        const secondRuntime = await acquireRuntime(provider("owner", "namespace"));
        const second = createItems(secondRuntime);
        await queryOnce((q) => q.from({ row: second }));

        expect(second.get("one")).toMatchObject({
            id: "one",
            title: "Persisted",
        });
        await second.cleanup();
        await secondRuntime.destroy?.();
    });

    it("resolves independent collection schemas on one database and preserves local data on mismatch", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const runtime = await acquireRuntime(
            createNodeRuntimeWithOptions({ dataDirectory: directory })("owner", "schemas")
        );
        const open = (name: string, schemaVersion: number) =>
            createLocalCollection<Item, string>({
                name,
                schemaVersion,
                runtime: runtimeFixtureContext(runtime).service,
                scope: runtimeFixtureContext(runtime).scope,
                getKey: (item) => item.id,
            });
        const tasks = open("tasks", 2);
        const settings = open("settings", 7);
        try {
            await Promise.all([
                queryOnce((q) => q.from({ row: tasks })),
                queryOnce((q) => q.from({ row: settings })),
            ]);
            await tasks.insert({ id: "task", title: "Task" }).isPersisted.promise;
            await settings.insert({ id: "setting", title: "Setting" }).isPersisted.promise;
            await tasks.cleanup();
            const incompatible = open("tasks", 3);
            try {
                await expect(queryOnce((q) => q.from({ row: incompatible }))).rejects.toMatchObject({
                    _tag: "OntologyStorageError",
                    reason: { _tag: "SchemaMismatch" },
                });
            } finally {
                await incompatible.cleanup();
            }
            await settings.insert({ id: "other", title: "Still active" }).isPersisted.promise;
            const reopened = open("tasks", 2);
            try {
                await queryOnce((q) => q.from({ row: reopened }));
                expect(reopened.get("task")?.title).toBe("Task");
            } finally {
                await reopened.cleanup();
            }
        } finally {
            await tasks.cleanup();
            await settings.cleanup();
            await runtime.cleanup?.();
        }
    });

    it("isolates runtime namespaces", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const provider = createNodeRuntimeWithOptions({
            dataDirectory: directory,
        });
        const first = await acquireRuntime(provider("owner", "one"));
        const second = await acquireRuntime(provider("owner", "two"));

        await Effect.runPromise(first.blobBytes.write("blob", new Blob(["first"])));
        await Effect.runPromise(second.blobBytes.write("blob", new Blob(["second"])));

        await expect(
            (
                await Effect.runPromise(
                    collectByteBlob((await Effect.runPromise(first.blobBytes.read("blob")))!)
                )
            ).text()
        ).resolves.toBe("first");
        await expect(
            (
                await Effect.runPromise(
                    collectByteBlob((await Effect.runPromise(second.blobBytes.read("blob")))!)
                )
            ).text()
        ).resolves.toBe("second");
        await first.destroy?.();
        await second.destroy?.();
    });
});
