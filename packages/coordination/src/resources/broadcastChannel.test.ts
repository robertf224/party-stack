import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { broadcastChannel } from "./broadcastChannel.js";

class TestBroadcastChannel extends EventTarget implements BroadcastChannel {
    static readonly channels = new Map<string, Set<TestBroadcastChannel>>();
    readonly name: string;
    onmessage: BroadcastChannel["onmessage"] = null;
    onmessageerror: BroadcastChannel["onmessageerror"] = null;
    private closed = false;

    constructor(name: string) {
        super();
        this.name = name;
        const channels = TestBroadcastChannel.channels.get(name) ?? new Set<TestBroadcastChannel>();
        channels.add(this);
        TestBroadcastChannel.channels.set(name, channels);
    }

    postMessage(message: unknown): void {
        const channelsSnapshot = [...(TestBroadcastChannel.channels.get(this.name) ?? [])];
        for (const channel of channelsSnapshot) {
            if (channel === this || channel.closed) {
                continue;
            }
            const event = new MessageEvent("message", {
                data: structuredClone(message),
            });
            queueMicrotask(() => {
                channel.dispatchEvent(event);
                channel.onmessage?.call(channel, event);
            });
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        const channels = TestBroadcastChannel.channels.get(this.name);
        channels?.delete(this);
        if (channels?.size === 0) {
            TestBroadcastChannel.channels.delete(this.name);
        }
    }
}

let previousBroadcastChannel: typeof BroadcastChannel | undefined;

beforeEach(() => {
    previousBroadcastChannel = globalThis.BroadcastChannel;
    TestBroadcastChannel.channels.clear();
    Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: TestBroadcastChannel,
    });
});

afterEach(() => {
    TestBroadcastChannel.channels.clear();
    Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: previousBroadcastChannel,
    });
});

describe("broadcastChannel", () => {
    it("provides a scoped native event stream", async () => {
        const received = vi.fn();
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const sender = yield* broadcastChannel<{
                        value: number;
                    }>("resource-channel");
                    const receiver = yield* broadcastChannel<{
                        value: number;
                    }>("resource-channel");
                    yield* Stream.runForEach(Stream.take(receiver.messages, 1), (event) =>
                        Effect.sync(() => received(event.data))
                    ).pipe(Effect.forkScoped({ startImmediately: true }));
                    sender.postMessage({ value: 42 });
                    yield* Effect.promise(() =>
                        vi.waitFor(() => {
                            expect(received).toHaveBeenCalledWith({
                                value: 42,
                            });
                        })
                    );
                })
            )
        );

        expect(TestBroadcastChannel.channels.size).toBe(0);
    });
});
