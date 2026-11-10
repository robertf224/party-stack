import { Effect, Queue, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { makeObjectSetWatcher } from "./ObjectSetWatcher.js";
import type { ObjectSetSubscriptionMessage } from "./types.js";
import type { OntologyClient } from "@party-stack/foundry-client";

test("socket failure notifies subscriptions created after the watcher owner", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const sent = yield* Queue.unbounded<{ id: string; requests: unknown[] }>();
                const messages = yield* Queue.unbounded<ObjectSetSubscriptionMessage>();
                const socket = new EventTarget() as EventTarget & {
                    readyState: number;
                    send(text: string): void;
                    close(): void;
                };
                socket.readyState = 1;
                socket.send = (text) => {
                    Queue.offerUnsafe(sent, JSON.parse(text) as { id: string; requests: unknown[] });
                };
                socket.close = () => {
                    socket.readyState = 3;
                    socket.dispatchEvent(new Event("close"));
                };
                const watcher = yield* makeObjectSetWatcher({
                    baseUrl: "https://foundry.example",
                    ontologyRid: "ontology",
                    createWebSocket: async () => socket as unknown as WebSocket,
                } as unknown as OntologyClient);
                yield* Effect.forkScoped(
                    Stream.runForEach(watcher.subscribe({ type: "base", objectType: "Issue" }), (message) =>
                        Queue.offer(messages, message)
                    ),
                    { startImmediately: true }
                );
                const request = yield* Queue.take(sent);
                socket.dispatchEvent(
                    new MessageEvent("message", {
                        data: JSON.stringify({
                            type: "subscribeResponses",
                            id: request.id,
                            responses: request.requests.map(() => ({ type: "success", id: "remote-issue" })),
                        }),
                    })
                );
                expect(yield* Queue.take(messages)).toEqual({ type: "state", status: "open" });
                socket.close();
                expect(yield* Queue.take(messages)).toEqual({ type: "state", status: "closed" });
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});
