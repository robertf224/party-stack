import { Table } from "@party-stack/ontology-storage/tables";
import { createLocalCollection } from "@party-stack/ontology/tanstack";
import { byteSource } from "@party-stack/runtime";
import { Runtime } from "@party-stack/runtime";
import { createLiveQueryCollection, queryOnce } from "@tanstack/db";
import { Effect, ManagedRuntime, Scope, Stream } from "effect";
import { layer } from "../src/WebRuntime.js";

// Drop storage notifications while retaining real native locks and IndexedDB.
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
            if (dropEvents && (event.data === null || event.data?.type === "event")) return;
            const message = new MessageEvent("message", { data: event.data });
            this.dispatchEvent(message);
            this.onmessage?.(message);
        });
        this.channel.addEventListener("messageerror", () => this.dispatchEvent(new Event("messageerror")));
    }
    postMessage(value: unknown) {
        this.channel.postMessage(value);
    }
    close() {
        this.channel.close();
    }
}
globalThis.BroadcastChannel = LossyBroadcastChannel as unknown as typeof BroadcastChannel;

interface Item {
    id: string;
    title: string;
    score: number;
}
const namespace = new URL(location.href).searchParams.get("scope")!;
const app = ManagedRuntime.make(layer({ owner: "browser-test", namespace }));
const service = await app.runPromise(Runtime);
const runtime = service.adapter;
let ownsHost = false;
const hostScope = await app.runPromise(Scope.fork(service.scope));
void app
    .runPromise(Scope.provide(runtime.acquireHost!, hostScope))
    .then(() => {
        ownsHost = true;
    })
    .catch(() => undefined);
const collection = createLocalCollection<Item, string>({ name: "items", runtime, getKey: (item) => item.id });
const query = createLiveQueryCollection((q) =>
    q.from({ item: collection }).orderBy(({ item }) => item.score)
);
const subscription = query.subscribeChanges(() => {}, { includeInitialState: true });
await queryOnce((q) => q.from({ item: query }));
Object.assign(window, {
    persistenceTest: {
        streamRecording: async (fail = false) => {
            const chunks = function* () {
                for (let part = 0; part < 160; part++) yield new Uint8Array(64 * 1024).fill(part);
            };
            const source = Stream.fromIterable(chunks(), { chunkSize: 1 });
            const result = await app.runPromise(
                Effect.result(
                    service.bytes.write(fail ? "interrupted-recording" : "recording", {
                        type: "audio/webm",
                        stream: fail
                            ? Stream.concat(source, Stream.fail(new Error("Recording interrupted")))
                            : source,
                    })
                )
            );
            return result._tag;
        },
        recordingSize: async (fail = false) => {
            const input = await app.runPromise(
                service.bytes.read(fail ? "interrupted-recording" : "recording")
            );
            return input
                ? await app.runPromise(
                      Stream.runFold(
                          byteSource(input).stream,
                          () => 0,
                          (size, part) => size + part.length
                      )
                  )
                : undefined;
        },
        durable: async () => {
            const service = await app.runPromise(Runtime);
            const table = Table.make<Item>({
                name: JSON.stringify(["local", runtime.owner, runtime.namespace, "items"]),
            });
            return {
                keys: (await app.runPromise(service.tables.loadSubset(table))).map((row) => row.key),
            };
        },
        rows: () => [...query.values()].map(({ id, title, score }) => ({ id, title, score })),
        insert: async (item: Item) => {
            await collection.insert(item).isPersisted.promise;
        },
        update: async (id: string, title: string) => {
            await collection.update(id, (draft) => {
                draft.title = title;
            }).isPersisted.promise;
        },
        remove: async (id: string) => {
            await collection.delete(id).isPersisted.promise;
        },
        drop: (value: boolean) => {
            dropEvents = value;
        },
        resume: () => {
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        },
        leader: () => ownsHost,
        cleanup: async () => {
            subscription.unsubscribe();
            await query.cleanup();
            await collection.cleanup();
            await app.dispose();
        },
    },
});
