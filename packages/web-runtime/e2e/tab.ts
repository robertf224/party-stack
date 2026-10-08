import { createCollection, createLiveQueryCollection } from "@tanstack/db";
import { createLocalCollection } from "@party-stack/runtime";
import { createIndexedDBPersistence } from "@party-stack/db-indexeddb-persistence";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { BroadcastCollectionCoordinator } from "@tanstack/db-sqlite-persistence-core/broadcast-coordinator";
import { createWebRuntime } from "../src/createWebRuntime.js";

// Drop only event notifications; RPC, leader election, locks, and storage stay real.
const NativeBroadcastChannel = globalThis.BroadcastChannel;
let dropEvents = false;
class LossyBroadcastChannel extends EventTarget {
    private readonly channel: BroadcastChannel;
    readonly name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(name: string) {
        super();
        this.name = name;
        this.channel = new NativeBroadcastChannel(name);
        this.channel.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
            if (dropEvents && event.data.type === "event") return;
            const message = new MessageEvent("message", { data: event.data });
            this.dispatchEvent(message);
            this.onmessage?.(message);
        });
        this.channel.addEventListener("messageerror", () => this.dispatchEvent(new Event("messageerror")));
    }
    postMessage(value: unknown) { this.channel.postMessage(value); }
    close() { this.channel.close(); }
}
globalThis.BroadcastChannel = LossyBroadcastChannel as unknown as typeof BroadcastChannel;

interface Item { id: string; title: string; score: number }
const namespace = new URL(location.href).searchParams.get("scope")!;
const runtime = await createWebRuntime("browser-test", namespace);
const upstream = new URL(location.href).searchParams.get("coordinator") === "upstream"
    ? new BroadcastCollectionCoordinator({ dbName: namespace, coordinatorName: "contract-control" }) : undefined;
const upstreamPersistence = upstream ? createIndexedDBPersistence({ databaseName: `upstream-${namespace}`, coordinator: upstream }) : undefined;
const collection = upstreamPersistence
    ? createCollection(persistedCollectionOptions<Item, string>({ id: "items", getKey: (item) => item.id, persistence: upstreamPersistence }))
    : createLocalCollection<Item, string>({ name: "items", runtime, getKey: (item) => item.id });
const query = createLiveQueryCollection((q) => q.from({ item: collection }).orderBy(({ item }) => item.score));
await Promise.all([collection.preload(), query.preload()]);
Object.assign(window, {
    persistenceTest: {
        durable: async () => ({ position: await (upstreamPersistence ?? runtime.persistence)!.adapter.getStreamPosition?.(collection.id), keys: (await (upstreamPersistence ?? runtime.persistence)!.adapter.loadSubset(collection.id, {})).map((row) => row.key) }),
        rows: () => [...query.values()].map(({ id, title, score }) => ({ id, title, score })),
        insert: async (item: Item) => { await collection.insert(item).isPersisted.promise; },
        update: async (id: string, title: string) => { await collection.update(id, (draft) => { draft.title = title; }).isPersisted.promise; },
        remove: async (id: string) => { await collection.delete(id).isPersisted.promise; },
        drop: (value: boolean) => { dropEvents = value; },
        resume: () => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); },
        leader: () => "isLeader" in runtime.coordination && runtime.coordination.isLeader,
        cleanup: async () => { await query.cleanup(); await collection.cleanup(); upstream?.dispose(); upstreamPersistence?.close(); await runtime.cleanup?.(); },
    },
});
