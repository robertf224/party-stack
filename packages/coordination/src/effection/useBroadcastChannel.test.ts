import {
    each,
    run,
    spawn,
    until,
} from "effection";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { useBroadcastChannel } from "./useBroadcastChannel.js";

class TestBroadcastChannel
    extends EventTarget
    implements BroadcastChannel
{
    static readonly channels = new Map<
        string,
        Set<TestBroadcastChannel>
    >();
    readonly name: string;
    onmessage: BroadcastChannel["onmessage"] = null;
    onmessageerror: BroadcastChannel["onmessageerror"] =
        null;
    private closed = false;

    constructor(name: string) {
        super();
        this.name = name;
        const channels =
            TestBroadcastChannel.channels.get(name) ??
            new Set<TestBroadcastChannel>();
        channels.add(this);
        TestBroadcastChannel.channels.set(
            name,
            channels
        );
    }

    postMessage(message: unknown): void {
        for (const channel of [
            ...(TestBroadcastChannel.channels.get(
                this.name
            ) ?? []),
        ]) {
            if (channel === this || channel.closed) {
                continue;
            }
            const event = new MessageEvent("message", {
                data: structuredClone(message),
            });
            queueMicrotask(() => {
                channel.dispatchEvent(event);
                channel.onmessage?.call(
                    channel,
                    event
                );
            });
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        const channels =
            TestBroadcastChannel.channels.get(
                this.name
            );
        channels?.delete(this);
        if (channels?.size === 0) {
            TestBroadcastChannel.channels.delete(
                this.name
            );
        }
    }
}

let previousBroadcastChannel:
    | typeof BroadcastChannel
    | undefined;

beforeEach(() => {
    previousBroadcastChannel =
        globalThis.BroadcastChannel;
    TestBroadcastChannel.channels.clear();
    Object.defineProperty(
        globalThis,
        "BroadcastChannel",
        {
            configurable: true,
            value: TestBroadcastChannel,
        }
    );
});

afterEach(() => {
    TestBroadcastChannel.channels.clear();
    Object.defineProperty(
        globalThis,
        "BroadcastChannel",
        {
            configurable: true,
            value: previousBroadcastChannel,
        }
    );
});

describe("useBroadcastChannel", () => {
    it("provides a scoped native event stream", async () => {
        const received = vi.fn();
        await run(function* () {
            const sender =
                yield* useBroadcastChannel<{
                    value: number;
                }>("resource-channel");
            const receiver =
                yield* useBroadcastChannel<{
                    value: number;
                }>("resource-channel");
            void (yield* spawn(function* () {
                for (const event of yield* each(
                    receiver
                )) {
                    received(event.data);
                    return;
                }
            }));
            sender.postMessage({ value: 42 });
            yield* until(
                vi.waitFor(() => {
                    expect(received).toHaveBeenCalledWith({
                        value: 42,
                    });
                })
            );
        });

        expect(
            TestBroadcastChannel.channels.size
        ).toBe(0);
    });
});
