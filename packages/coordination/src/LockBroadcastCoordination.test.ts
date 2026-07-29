import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { LockBroadcastCoordination } from "./index.js";

type TestService = {
    methods: {
        double(input: { value: number }): Promise<number>;
        wait(input: { value: number }): Promise<number>;
    };
    events: {
        changed: { value: number };
    };
};

class LocalBroadcastChannel
    extends EventTarget
    implements BroadcastChannel
{
    static readonly channels = new Map<
        string,
        Set<LocalBroadcastChannel>
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
            LocalBroadcastChannel.channels.get(name) ??
            new Set<LocalBroadcastChannel>();
        channels.add(this);
        LocalBroadcastChannel.channels.set(
            name,
            channels
        );
    }

    postMessage(message: unknown): void {
        for (const channel of [
            ...(LocalBroadcastChannel.channels.get(
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
            LocalBroadcastChannel.channels.get(
                this.name
            );
        channels?.delete(this);
        if (channels?.size === 0) {
            LocalBroadcastChannel.channels.delete(
                this.name
            );
        }
    }
}

class LocalLockManager implements LockManager {
    private readonly tails = new Map<
        string,
        Promise<unknown>
    >();

    request<T>(
        name: string,
        callback: (
            lock: Lock | null
        ) => T | PromiseLike<T>
    ): Promise<T>;
    request<T>(
        name: string,
        options: LockOptions,
        callback: (
            lock: Lock | null
        ) => T | PromiseLike<T>
    ): Promise<T>;
    request<T>(
        name: string,
        optionsOrCallback:
            | LockOptions
            | ((
                  lock: Lock | null
              ) => T | PromiseLike<T>),
        callback?: (
            lock: Lock | null
        ) => T | PromiseLike<T>
    ): Promise<T> {
        const options =
            typeof optionsOrCallback === "function"
                ? {}
                : optionsOrCallback;
        const grant =
            typeof optionsOrCallback === "function"
                ? optionsOrCallback
                : callback!;
        const previous =
            this.tails.get(name) ??
            Promise.resolve();
        const operation = previous.then(
            async () => {
                if (options.signal?.aborted) {
                    throw (
                        options.signal.reason ??
                        new DOMException(
                            "The operation was aborted.",
                            "AbortError"
                        )
                    );
                }
                return grant({
                    mode:
                        options.mode ?? "exclusive",
                    name,
                } as Lock);
            }
        );
        this.tails.set(
            name,
            operation.catch(() => undefined)
        );
        return operation;
    }

    query(): Promise<LockManagerSnapshot> {
        return Promise.resolve({
            held: [],
            pending: [],
        });
    }
}

let restoreWebApis: (() => void) | undefined;

beforeEach(() => {
    const previousBroadcastChannel =
        globalThis.BroadcastChannel;
    const navigatorDescriptor =
        Object.getOwnPropertyDescriptor(
            globalThis,
            "navigator"
        );
    LocalBroadcastChannel.channels.clear();
    Object.defineProperty(
        globalThis,
        "BroadcastChannel",
        {
            configurable: true,
            value: LocalBroadcastChannel,
        }
    );
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            ...(globalThis.navigator ?? {}),
            locks: new LocalLockManager(),
        },
    });
    restoreWebApis = () => {
        LocalBroadcastChannel.channels.clear();
        Object.defineProperty(
            globalThis,
            "BroadcastChannel",
            {
                configurable: true,
                value: previousBroadcastChannel,
            }
        );
        if (navigatorDescriptor) {
            Object.defineProperty(
                globalThis,
                "navigator",
                navigatorDescriptor
            );
        } else {
            Reflect.deleteProperty(
                globalThis,
                "navigator"
            );
        }
    };
});

afterEach(() => {
    restoreWebApis?.();
    restoreWebApis = undefined;
});

function createPair(scope: string) {
    const first = new LockBroadcastCoordination({
        scope,
        requestTimeoutMs: 30,
        requestAttempts: 10,
    });
    const second = new LockBroadcastCoordination({
        scope,
        requestTimeoutMs: 30,
        requestAttempts: 10,
    });
    return { first, second };
}

function serve(coordination: LockBroadcastCoordination) {
    return coordination.serve<TestService>("test.v1", {
        double: ({ value }) => value * 2,
        wait: ({ value }) => value,
    });
}

describe("LockBroadcastCoordination", () => {
    it("routes follower calls to the leader and fans out events", async () => {
        const { first, second } = createPair("routing");
        const firstServer = serve(first);
        const secondServer = serve(second);
        await vi.waitFor(() =>
            expect(first.isLeader || second.isLeader).toBe(true)
        );
        const leader = first.isLeader ? first : second;
        const follower = first.isLeader ? second : first;
        const server = first.isLeader
            ? firstServer
            : secondServer;
        const listener = vi.fn();
        follower
            .service<TestService>("test.v1")
            .events.subscribe("changed", listener);

        await expect(
            follower
                .service<TestService>("test.v1")
                .methods.double({ value: 4 })
        ).resolves.toBe(8);
        server.events.publish("changed", { value: 9 });
        await vi.waitFor(() =>
            expect(listener).toHaveBeenCalledWith({
                value: 9,
            })
        );

        await leader.close();
        await follower.close();
    });

    it("preserves FIFO remotely and permits same-service nesting", async () => {
        const { first, second } = createPair("lanes");
        const order: number[] = [];
        const register = (
            coordination: LockBroadcastCoordination
        ) =>
            coordination.serve<TestService>("test.v1", {
                double: ({ value }, context) =>
                    value === 1
                        ? context.coordination
                              .service<TestService>("test.v1")
                              .methods.double({ value: 2 })
                        : value * 2,
                wait: async ({ value }) => {
                    await new Promise((resolve) =>
                        setTimeout(resolve, 2)
                    );
                    order.push(value);
                    return value;
                },
            });
        register(first);
        register(second);
        await vi.waitFor(() =>
            expect(first.isLeader || second.isLeader).toBe(true)
        );
        const follower = first.isLeader ? second : first;
        const client =
            follower.service<TestService>("test.v1");

        await expect(
            Promise.all([
                client.methods.wait({ value: 1 }),
                client.methods.wait({ value: 2 }),
                client.methods.wait({ value: 3 }),
            ])
        ).resolves.toEqual([1, 2, 3]);
        expect(order).toEqual([1, 2, 3]);
        await expect(
            client.methods.double({ value: 1 })
        ).resolves.toBe(4);
        await first.close();
        await second.close();
    });

    it("fails over leadership and runs waiting leader work", async () => {
        const { first, second } = createPair("failover");
        serve(first);
        serve(second);
        await vi.waitFor(() =>
            expect(first.isLeader || second.isLeader).toBe(true)
        );
        const leader = first.isLeader ? first : second;
        const follower = first.isLeader ? second : first;
        const callback = vi.fn(() => "leading");
        const waiting = follower.runAsLeader(callback);

        await leader.close();

        await expect(waiting).resolves.toBe("leading");
        expect(callback).toHaveBeenCalledOnce();
        expect(follower.isLeader).toBe(true);
        await expect(
            follower
                .service<TestService>("test.v1")
                .methods.double({ value: 5 })
        ).resolves.toBe(10);
        await follower.close();
    });

    it("waits for leader callback cleanup before lock failover", async () => {
        const { first, second } = createPair("leader-cleanup");
        serve(first);
        serve(second);
        await vi.waitFor(() =>
            expect(first.isLeader || second.isLeader).toBe(true)
        );
        const leader = first.isLeader ? first : second;
        const follower = first.isLeader ? second : first;
        const started = promiseWithResolvers<void>();
        const cleanupGate = promiseWithResolvers<void>();
        const cleaned = promiseWithResolvers<void>();
        const operation = leader.runAsLeader(
            async ({ signal }) => {
                started.resolve();
                await new Promise<void>((resolve) =>
                    signal.addEventListener(
                        "abort",
                        () => resolve(),
                        { once: true }
                    )
                );
                await cleanupGate.promise;
                cleaned.resolve();
            }
        );
        const operationResult =
            expect(operation).rejects.toMatchObject({
                code: "CLOSED",
            });
        await started.promise;

        const closing = leader.close();
        await Promise.resolve();
        expect(follower.isLeader).toBe(false);
        cleanupGate.resolve();
        await closing;

        await expect(cleaned.promise).resolves.toBeUndefined();
        await operationResult;
        await vi.waitFor(() =>
            expect(follower.isLeader).toBe(true)
        );
        await follower.close();
    });

    it("waits for inbound handler cleanup before lock failover", async () => {
        const { first, second } = createPair(
            "handler-cleanup"
        );
        await vi.waitFor(() =>
            expect(
                first.isLeader || second.isLeader
            ).toBe(true)
        );
        const leader = first.isLeader
            ? first
            : second;
        const follower = first.isLeader
            ? second
            : first;
        const started = promiseWithResolvers<void>();
        const cleanupGate =
            promiseWithResolvers<void>();
        const cleaned = promiseWithResolvers<void>();
        leader.serve<TestService>("test.v1", {
            double: ({ value }) => value * 2,
            wait: async ({ value }, context) => {
                started.resolve();
                await new Promise<void>((resolve) =>
                    context.signal.addEventListener(
                        "abort",
                        () => resolve(),
                        { once: true }
                    )
                );
                await cleanupGate.promise;
                cleaned.resolve();
                return value;
            },
        });
        follower.serve<TestService>("test.v1", {
            double: ({ value }) => value * 2,
            wait: ({ value }) => value,
        });
        const request = follower
            .service<TestService>("test.v1")
            .methods.wait({ value: 7 });
        await started.promise;

        const closing = leader.close();
        await Promise.resolve();
        expect(follower.isLeader).toBe(false);
        cleanupGate.resolve();
        await closing;

        await expect(
            cleaned.promise
        ).resolves.toBeUndefined();
        await vi.waitFor(() =>
            expect(follower.isLeader).toBe(true)
        );
        await expect(request).resolves.toBe(7);
        await follower.close();
    });

    it("propagates remote cancellation into the handler", async () => {
        const { first, second } = createPair("cancel");
        const started = promiseWithResolvers<void>();
        const aborted = promiseWithResolvers<void>();
        const register = (
            coordination: LockBroadcastCoordination
        ) =>
            coordination.serve<TestService>("test.v1", {
                double: ({ value }) => value * 2,
                wait: async ({ value }, context) => {
                    started.resolve();
                    await new Promise<void>((resolve) =>
                        context.signal.addEventListener(
                            "abort",
                            () => resolve(),
                            { once: true }
                        )
                    );
                    aborted.resolve();
                    return value;
                },
            });
        register(first);
        register(second);
        await vi.waitFor(() =>
            expect(first.isLeader || second.isLeader).toBe(true)
        );
        const follower = first.isLeader ? second : first;
        const controller = new AbortController();
        const request = follower
            .service<TestService>("test.v1")
            .methods.wait(
                { value: 1 },
                { signal: controller.signal }
            );
        await started.promise;

        controller.abort();

        await expect(request).rejects.toMatchObject({
            name: "AbortError",
        });
        await expect(aborted.promise).resolves.toBeUndefined();
        await first.close();
        await second.close();
    });

    it("rejects malformed protocol and scope messages", async () => {
        const { first, second } =
            createPair("protocol");
        serve(first);
        serve(second);
        await vi.waitFor(() =>
            expect(first.isLeader || second.isLeader).toBe(true)
        );
        const observer = new BroadcastChannel(
            "party-stack.coordination:protocol"
        );
        const response =
            promiseWithResolvers<Record<string, unknown>>();
        observer.addEventListener("message", (event) => {
            const message = event.data as Record<
                string,
                unknown
            >;
            if (
                message.type === "response" &&
                message.recipientId === "rogue"
            ) {
                response.resolve(message);
            }
        });

        observer.postMessage({
            v: 99,
            scope: "wrong",
            type: "request",
            requestId: "bad-request",
            senderId: "rogue",
            service: "test.v1",
            method: "double",
            payload: { value: 1 },
        });

        await expect(response.promise).resolves.toMatchObject({
            ok: false,
            error: { code: "PROTOCOL_MISMATCH" },
        });
        observer.close();
        await first.close();
        await second.close();
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
