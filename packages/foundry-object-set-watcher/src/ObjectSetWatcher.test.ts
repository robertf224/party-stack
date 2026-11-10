import { Effect, Exit, Scope, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeObjectSetWatcher } from "./ObjectSetWatcher.js";
import { getObjectSetWatcherManager } from "./ObjectSetWatcherManager.js";
import type { ObjectSetSubscriptionMessage } from "./types.js";
import type { OntologyClient } from "@party-stack/foundry-client";

class Socket extends EventTarget {
    readyState = 1;
    requests: { id: string; requests: unknown[] }[] = [];
    acknowledge: "success" | "qos" | "none" = "success";
    close = vi.fn(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
    });
    send(text: string) {
        const request = JSON.parse(text) as { id: string; requests: unknown[] };
        this.requests.push(request);
        queueMicrotask(() => {
            if (this.readyState !== 1 || this.acknowledge === "none") return;
            this.message({
                type: "subscribeResponses",
                id: request.id,
                responses: request.requests.map((_, index) =>
                    this.acknowledge === "success"
                        ? { type: "success", id: `remote-${index}` }
                        : { type: "qos" }
                ),
            });
        });
    }
    message(data: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
}
const client = (create: () => Promise<Socket>): OntologyClient => ({
    baseUrl: "https://example.invalid",
    ontologyRid: "test-ontology",
    tokenProvider: async () => "unused",
    fetch: globalThis.fetch,
    createWebSocket: () => create() as unknown as Promise<WebSocket>,
});
const until = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

test("stopped callback managers are replaced in the client cache", async () => {
    const connection = client(async () => new Socket());
    const first = getObjectSetWatcherManager(connection);
    expect(first.stopped).toBe(false);
    await first.stop();
    const second = getObjectSetWatcherManager(connection);
    expect(second).not.toBe(first);
    await second.stop();
});

test("shared watcher subscriptions preserve changes and close their socket when the last consumer leaves", async () => {
    const socket = new Socket();
    const create = vi.fn(async () => socket);
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const watcher = yield* makeObjectSetWatcher(client(create));
                const first = yield* Scope.fork(yield* Effect.scope);
                const second = yield* Scope.fork(yield* Effect.scope);
                const a: ObjectSetSubscriptionMessage[] = [];
                const b: ObjectSetSubscriptionMessage[] = [];
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe({ type: "base", objectType: "Note" }), (value) =>
                        Effect.sync(() => {
                            a.push(value);
                        })
                    ),
                    first
                );
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe({ objectType: "Note", type: "base" }), (value) =>
                        Effect.sync(() => {
                            b.push(value);
                        })
                    ),
                    second
                );
                yield* until(() => {
                    expect(a.some((message) => message.type === "state" && message.status === "open")).toBe(
                        true
                    );
                    expect(b.some((message) => message.type === "state" && message.status === "open")).toBe(
                        true
                    );
                });
                expect(create).toHaveBeenCalledTimes(1);
                expect(socket.requests.every((request) => request.requests.length === 1)).toBe(true);
                socket.message({
                    type: "objectSetChanged",
                    id: "remote-0",
                    updates: [
                        {
                            type: "object",
                            state: "ADDED_OR_UPDATED",
                            object: { __primaryKey: "one", title: "Latest" },
                        },
                    ],
                });
                yield* until(() => {
                    expect(a.some((value) => value.type === "change")).toBe(true);
                    expect(b.some((value) => value.type === "change")).toBe(true);
                });
                const changed = a.find((value) => value.type === "change");
                expect(
                    changed?.type === "change" &&
                        changed.updates[0]?.type === "object" &&
                        changed.updates[0].object.title
                ).toBe("Latest");
                yield* Scope.close(first, Exit.void);
                expect(socket.close).not.toHaveBeenCalled();
                yield* Scope.close(second, Exit.void);
                expect(socket.close).toHaveBeenCalledOnce();
            })
        )
    );
});

test("a socket created after cancellation is immediately closed", async () => {
    const socket = new Socket();
    let resolve!: (value: Socket) => void;
    const pending = new Promise<Socket>((ready) => {
        resolve = ready;
    });
    const create = vi.fn(() => pending);
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const watcher = yield* makeObjectSetWatcher(client(create));
                const consumer = yield* Scope.fork(yield* Effect.scope);
                yield* Effect.forkIn(
                    Stream.runDrain(watcher.subscribe({ type: "base", objectType: "Note" })),
                    consumer
                );
                yield* until(() => expect(create).toHaveBeenCalledOnce());
                yield* Scope.close(consumer, Exit.void);
                resolve(socket);
                yield* until(() => expect(socket.close).toHaveBeenCalledOnce());
            })
        )
    );
});

test("logical consumers share physical subscription state without resending the request list", async () => {
    const socket = new Socket();
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const watcher = yield* makeObjectSetWatcher(client(async () => socket));
                const first = yield* Scope.fork(yield* Effect.scope);
                const second = yield* Scope.fork(yield* Effect.scope);
                const a: ObjectSetSubscriptionMessage[] = [];
                const b: ObjectSetSubscriptionMessage[] = [];
                const set = {
                    type: "filter" as const,
                    objectSet: { type: "base" as const, objectType: "Note" },
                    where: { type: "eq" as const, field: "project", value: "one" },
                };
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe(set), (message) =>
                        Effect.sync(() => {
                            a.push(message);
                        })
                    ),
                    first
                );
                yield* until(() =>
                    expect(a.some((message) => message.type === "state" && message.status === "open")).toBe(
                        true
                    )
                );
                // Wait for the current request response; joining only adds a local consumer.
                yield* Effect.sleep(5);
                const requests = socket.requests.length;
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe(set), (message) =>
                        Effect.sync(() => {
                            b.push(message);
                        })
                    ),
                    second
                );
                yield* until(() =>
                    expect(b.some((message) => message.type === "state" && message.status === "open")).toBe(
                        true
                    )
                );
                expect(socket.requests).toHaveLength(requests);
                yield* Scope.close(first, Exit.void);
                yield* Effect.sleep(5);
                expect(socket.requests).toHaveLength(requests);
                expect(socket.close).not.toHaveBeenCalled();
                yield* Scope.close(second, Exit.void);
                expect(socket.close).toHaveBeenCalledOnce();
            })
        )
    );
});

test("distinct filtered object sets share a socket and update the physical request list independently", async () => {
    const socket = new Socket();
    const create = vi.fn(async () => socket);
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const watcher = yield* makeObjectSetWatcher(client(create));
                const first = yield* Scope.fork(yield* Effect.scope);
                const second = yield* Scope.fork(yield* Effect.scope);
                const a: ObjectSetSubscriptionMessage[] = [];
                const b: ObjectSetSubscriptionMessage[] = [];
                const set = (project: string) => ({
                    type: "filter" as const,
                    objectSet: { type: "base" as const, objectType: "Note" },
                    where: { type: "eq" as const, field: "project", value: project },
                });
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe(set("one")), (message) =>
                        Effect.sync(() => {
                            a.push(message);
                        })
                    ),
                    first
                );
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe(set("two")), (message) =>
                        Effect.sync(() => {
                            b.push(message);
                        })
                    ),
                    second
                );
                yield* until(() => expect(socket.requests.at(-1)?.requests).toHaveLength(2));
                yield* until(() =>
                    expect(b.some((message) => message.type === "state" && message.status === "open")).toBe(
                        true
                    )
                );
                expect(create).toHaveBeenCalledOnce();
                socket.message({ type: "refreshObjectSet", id: "remote-1", objectType: "Note" });
                yield* until(() => expect(b.some((message) => message.type === "refresh")).toBe(true));
                expect(a.some((message) => message.type === "refresh")).toBe(false);
                yield* Scope.close(first, Exit.void);
                yield* until(() =>
                    expect(socket.requests.at(-1)?.requests).toEqual([
                        { objectSet: set("two"), propertySet: [], referenceSet: [] },
                    ])
                );
                expect(socket.close).not.toHaveBeenCalled();
                yield* Scope.close(second, Exit.void);
                expect(socket.close).toHaveBeenCalledOnce();
            })
        )
    );
});

test("QoS reconnects within the scope and resubscribes the current demand", async () => {
    const sockets: Socket[] = [];
    const create = async () => {
        const socket = new Socket();
        if (!sockets.length) socket.acknowledge = "qos";
        sockets.push(socket);
        return socket;
    };
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const watcher = yield* makeObjectSetWatcher(client(create), { retryDelayMs: 5 });
                const consumer = yield* Scope.fork(yield* Effect.scope);
                const messages: ObjectSetSubscriptionMessage[] = [];
                yield* Effect.forkIn(
                    Stream.runForEach(watcher.subscribe({ type: "base", objectType: "Note" }), (message) =>
                        Effect.sync(() => {
                            messages.push(message);
                        })
                    ),
                    consumer
                );
                yield* until(() => {
                    expect(sockets).toHaveLength(2);
                    expect(messages.some((value) => value.type === "state" && value.status === "open")).toBe(
                        true
                    );
                });
                expect(sockets[0]?.close).toHaveBeenCalledOnce();
                yield* Scope.close(consumer, Exit.void);
                expect(sockets[1]?.close).toHaveBeenCalledOnce();
            })
        )
    );
});
