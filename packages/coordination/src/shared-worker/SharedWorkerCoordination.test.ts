import { describe, expect, it, vi } from "vitest";
import { SharedWorkerCoordinationClient } from "./SharedWorkerCoordinationClient.js";
import { SharedWorkerCoordinationHost } from "./SharedWorkerCoordinationHost.js";
import type {
    CoordinationMessagePort,
    CoordinationPortEvent,
} from "./contracts.js";

type TestService = {
    methods: {
        echo(input: { value: string }): Promise<string>;
        fail(input: undefined): Promise<void>;
        wait(input: undefined): Promise<void>;
    };
    events: {
        changed: { value: string };
    };
};

class TestMessagePort implements CoordinationMessagePort {
    peer?: TestMessagePort;
    private readonly listeners = new Map<
        string,
        Set<(event: CoordinationPortEvent) => void>
    >();
    private closed = false;

    postMessage(message: unknown): void {
        if (this.closed) throw new Error("Port is closed.");
        const peer = this.peer;
        if (!peer) throw new Error("Port is not connected.");
        queueMicrotask(() => {
            if (!peer.closed) {
                peer.dispatch("message", { data: message });
            }
        });
    }

    addEventListener(
        type: "message" | "messageerror" | "close",
        listener: (event: CoordinationPortEvent) => void
    ): void {
        const listeners =
            this.listeners.get(type) ?? new Set();
        this.listeners.set(type, listeners);
        listeners.add(listener);
    }

    removeEventListener(
        type: "message" | "messageerror" | "close",
        listener: (event: CoordinationPortEvent) => void
    ): void {
        this.listeners.get(type)?.delete(listener);
    }

    start(): void {}

    close(): void {
        if (this.closed) return;
        this.closed = true;
        const peer = this.peer;
        queueMicrotask(() =>
            peer?.dispatch("close", {})
        );
    }

    private dispatch(
        type: "message" | "messageerror" | "close",
        event: CoordinationPortEvent
    ): void {
        for (const listener of [
            ...(this.listeners.get(type) ?? []),
        ]) {
            listener(event);
        }
    }
}

function messageChannel(): {
    port1: TestMessagePort;
    port2: TestMessagePort;
} {
    const port1 = new TestMessagePort();
    const port2 = new TestMessagePort();
    port1.peer = port2;
    port2.peer = port1;
    return { port1, port2 };
}

function serve(host: SharedWorkerCoordinationHost) {
    return host.serve<TestService>("test.v1", {
        echo: ({ value }) => value,
        fail: () => {
            throw new RangeError("handler failed");
        },
        wait: async (_input, context) => {
            await new Promise<void>((resolve) =>
                context.signal.addEventListener(
                    "abort",
                    () => resolve(),
                    { once: true }
                )
            );
        },
    });
}

describe("SharedWorker coordination", () => {
    it("handshakes, invokes typed services, and fans out events", async () => {
        const host = new SharedWorkerCoordinationHost({
            scope: "shared",
        });
        const server = serve(host);
        const channel = messageChannel();
        host.connect(channel.port1);
        const client = new SharedWorkerCoordinationClient({
            scope: "shared",
            worker: { port: channel.port2 },
            requestTimeoutMs: 100,
        });
        const listener = vi.fn();
        client
            .service<TestService>("test.v1")
            .events.subscribe("changed", listener);

        await expect(
            client
                .service<TestService>("test.v1")
                .methods.echo({ value: "hello" })
        ).resolves.toBe("hello");
        server.events.publish("changed", { value: "one" });
        await vi.waitFor(() =>
            expect(listener).toHaveBeenCalledWith({
                value: "one",
            })
        );
        await expect(
            client
                .service<TestService>("test.v1")
                .methods.fail(undefined)
        ).rejects.toMatchObject({
            name: "RangeError",
            message: "handler failed",
        });

        await client.close();
        await host.close();
    });

    it("rejects pending calls on disconnect and reconnects with a new identity", async () => {
        const host = new SharedWorkerCoordinationHost({
            scope: "reconnect",
        });
        serve(host);
        const firstChannel = messageChannel();
        const disconnect = host.connect(firstChannel.port1);
        const first = new SharedWorkerCoordinationClient({
            scope: "reconnect",
            worker: firstChannel.port2,
            requestTimeoutMs: 1_000,
        });
        await expect(
            first
                .service<TestService>("test.v1")
                .methods.echo({ value: "connected" })
        ).resolves.toBe("connected");
        const pending = first
            .service<TestService>("test.v1")
            .methods.wait(undefined);

        disconnect();

        await expect(pending).rejects.toMatchObject({
            code: "DISCONNECTED",
        });
        const secondChannel = messageChannel();
        host.connect(secondChannel.port1);
        const second = new SharedWorkerCoordinationClient({
            scope: "reconnect",
            worker: () => secondChannel.port2,
            requestTimeoutMs: 100,
        });
        await expect(
            second
                .service<TestService>("test.v1")
                .methods.echo({ value: "reconnected" })
        ).resolves.toBe("reconnected");

        await first.close();
        await second.close();
        await host.close();
    });

    it("rejects protocol and scope mismatches during handshake", async () => {
        const host = new SharedWorkerCoordinationHost({
            scope: "host-scope",
        });
        const channel = messageChannel();
        host.connect(channel.port1);
        const client = new SharedWorkerCoordinationClient({
            scope: "client-scope",
            worker: channel.port2,
            connectionTimeoutMs: 100,
        });

        await expect(
            client
                .service<TestService>("test.v1")
                .methods.echo({ value: "no" })
        ).rejects.toMatchObject({
            code: "PROTOCOL_MISMATCH",
        });
        await client.close();
        await host.close();
    });

    it("reports worker construction failures through queued calls", async () => {
        const failure = new Error("worker construction failed");
        const client = new SharedWorkerCoordinationClient({
            scope: "construction",
            worker: () => {
                throw failure;
            },
        });

        await expect(
            client
                .service<TestService>("test.v1")
                .methods.echo({ value: "no" })
        ).rejects.toBe(failure);
        await client.close();
    });

    it("aborts worker handlers when the client cancels", async () => {
        const host = new SharedWorkerCoordinationHost({
            scope: "cancel",
        });
        const started = promiseWithResolvers<void>();
        const aborted = promiseWithResolvers<void>();
        host.serve<TestService>("test.v1", {
            echo: ({ value }) => value,
            fail: () => undefined,
            wait: async (_input, context) => {
                started.resolve();
                await new Promise<void>((resolve) =>
                    context.signal.addEventListener(
                        "abort",
                        () => resolve(),
                        { once: true }
                    )
                );
                aborted.resolve();
            },
        });
        const channel = messageChannel();
        host.connect(channel.port1);
        const client = new SharedWorkerCoordinationClient({
            scope: "cancel",
            worker: channel.port2,
            requestTimeoutMs: 100,
        });
        const controller = new AbortController();
        const request = client
            .service<TestService>("test.v1")
            .methods.wait(undefined, {
                signal: controller.signal,
            });
        await started.promise;

        controller.abort();

        await expect(request).rejects.toMatchObject({
            name: "AbortError",
        });
        await expect(aborted.promise).resolves.toBeUndefined();
        await client.close();
        await host.close();
    });
});

function promiseWithResolvers<Value>() {
    let resolve!: (value: Value) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Value>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
