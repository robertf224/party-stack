import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalCollection } from "@party-stack/runtime";
import { SQLiteCorePersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";
import { Temporal } from "temporal-polyfill";
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
    it("reopens raw Temporal rows, metadata, and replay without an application codec", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-temporal-"));
        directories.push(directory);
        const provider = createNodeRuntimeWithOptions({ dataDirectory: directory });
        const instant = Temporal.Instant.from("2026-10-07T12:00:00.123456789Z");
        const date = Temporal.PlainDate.from("2026-10-07");
        const open = (runtime: Awaited<ReturnType<typeof provider>>) =>
            createLocalCollection<{ id: string; instant: Temporal.Instant; nested: { dates: Temporal.PlainDate[] } }, string>({
                name: "temporal", getKey: (item) => item.id, runtime, schemaVersion: 1,
            });
        const firstRuntime = await provider("owner", "temporal");
        const first = open(firstRuntime);
        const collectionId = first.id;
        try {
            await first.preload();
            await first.insert({ id: "one", instant, nested: { dates: [date] } }).isPersisted.promise;
            await first.cleanup();
            const adapter = firstRuntime.persistence!.adapter;
            const position = await adapter.loadResumeSnapshot(collectionId);
            await adapter.applyCommittedTx(collectionId, {
                txId: "temporal-metadata", term: position.latestTerm,
                seq: position.latestSeq + 1, rowVersion: position.latestRowVersion + 1,
                mutations: [],
                rowMetadataMutations: [{ type: "set", key: "one", value: { date } }],
                collectionMetadataMutations: [{ type: "set", key: "cursor", value: { instant } }],
            });
        } finally {
            await first.cleanup();
            await firstRuntime.cleanup?.();
        }

        const secondRuntime = await provider("owner", "temporal");
        const second = open(secondRuntime);
        try {
            await second.preload();
            expect(second.get("one")?.instant).toBeInstanceOf(Temporal.Instant);
            expect(second.get("one")?.instant.epochNanoseconds).toBe(instant.epochNanoseconds);
            expect(second.get("one")?.nested.dates[0]).toBeInstanceOf(Temporal.PlainDate);
            expect(second.get("one")?.nested.dates[0]?.toString()).toBe(date.toString());
            const adapter = secondRuntime.persistence!.adapter;
            const snapshot = await adapter.loadResumeSnapshot(collectionId);
            const rowMetadata = snapshot.rows[0]?.metadata as { date: unknown };
            expect(rowMetadata.date).toBeInstanceOf(Temporal.PlainDate);
            expect(String(rowMetadata.date)).toBe(date.toString());
            const cursor = snapshot.collectionMetadata.find((entry) => entry.key === "cursor")?.value as { instant: unknown };
            expect(cursor.instant).toBeInstanceOf(Temporal.Instant);
            expect(String(cursor.instant)).toBe(instant.toString());
            if (!(adapter instanceof SQLiteCorePersistenceAdapter)) throw new Error("Expected SQLite persistence");
            const replay = await adapter.pullSince(collectionId, 0);
            expect(replay.requiresFullReload).toBe(false);
            if (!replay.requiresFullReload) {
                const row = replay.deltas?.flatMap((delta) => delta.changedRows)[0];
                expect(row?.value.instant).toBeInstanceOf(Temporal.Instant);
                expect(String(row?.value.instant)).toBe(instant.toString());
                const rowMetadataDelta = replay.deltas?.flatMap((delta) => delta.rowMetadataMutations)
                    .find((mutation) => mutation.type === "set" && mutation.key === "one");
                const metadata = rowMetadataDelta?.type === "set" ? rowMetadataDelta.value as { date: unknown } : undefined;
                expect(metadata?.date).toBeInstanceOf(Temporal.PlainDate);
                expect(String(metadata?.date)).toBe(date.toString());
                const cursorDelta = replay.deltas?.flatMap((delta) => delta.collectionMetadataMutations)
                    .find((mutation) => mutation.type === "set" && mutation.key === "cursor");
                const replayCursor = cursorDelta?.type === "set" ? cursorDelta.value as { instant: unknown } : undefined;
                expect(replayCursor?.instant).toBeInstanceOf(Temporal.Instant);
                expect(String(replayCursor?.instant)).toBe(instant.toString());
            }
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

    it("resolves independent collection schemas on one database and preserves local data on mismatch", async () => {
        const directory = await mkdtemp(join(tmpdir(), "party-stack-runtime-"));
        directories.push(directory);
        const runtime = await createNodeRuntimeWithOptions({ dataDirectory: directory })("owner", "schemas");
        const open = (name: string, schemaVersion: number) => createLocalCollection<Item, string>({
            name, schemaVersion, runtime, getKey: (item) => item.id,
        });
        const tasks = open("tasks", 2);
        const settings = open("settings", 7);
        try {
            await Promise.all([tasks.preload(), settings.preload()]);
            await tasks.insert({ id: "task", title: "Task" }).isPersisted.promise;
            await settings.insert({ id: "setting", title: "Setting" }).isPersisted.promise;
            const resolve = runtime.persistence!.resolvePersistenceForCollection!;
            const current = resolve({ collectionId: tasks.id, mode: "sync-absent", schemaVersion: 2 }).adapter;
            const incompatible = resolve({ collectionId: tasks.id, mode: "sync-absent", schemaVersion: 3 }).adapter;
            await tasks.cleanup();
            await expect(incompatible.loadResumeSnapshot(tasks.id)).rejects.toThrow("Schema version mismatch");
            expect((await current.loadResumeSnapshot(tasks.id)).rows).toHaveLength(1);
            await settings.insert({ id: "other", title: "Still active" }).isPersisted.promise;
            const reopened = open("tasks", 2);
            try {
                await reopened.preload();
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
