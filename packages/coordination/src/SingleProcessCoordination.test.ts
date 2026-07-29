import { describe, expect, it, vi } from "vitest";
import {
    CoordinationServiceError,
    SingleProcessCoordination,
    isCoordinationHost,
    type CoordinationServiceHandlers,
} from "./index.js";

type TestService = {
    methods: {
        echo(input: { value: string }): Promise<string>;
        pause(input: { value: string }): Promise<string>;
        nested(input: { value: number }): Promise<number>;
    };
    events: {
        changed: { value: string };
    };
};

function handlers(
    overrides: Partial<
        CoordinationServiceHandlers<TestService>
    > = {}
): CoordinationServiceHandlers<TestService> {
    return {
        echo: ({ value }) => value,
        pause: ({ value }) => value,
        nested: ({ value }) => value,
        ...overrides,
    };
}

function promiseWithResolvers<Value>() {
    let resolve!: (value: Value) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Value>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("SingleProcessCoordination", () => {
    it("has the host role and returns stable typed clients", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "roles",
        });
        const first =
            coordination.service<TestService>("test.v1");
        const second =
            coordination.service<TestService>("test.v1");

        expect(coordination.role).toBe("host");
        expect(coordination.isLeader).toBe(true);
        expect(isCoordinationHost(coordination)).toBe(true);
        expect(first).toBe(second);

        coordination.serve("test.v1", handlers());
        await expect(
            first.methods.echo({ value: "hello" })
        ).resolves.toBe("hello");
        await coordination.close();
    });

    it("fans out typed events and isolates subscribers", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "events",
        });
        const client =
            coordination.service<TestService>("test.v1");
        const first = vi.fn(() => {
            throw new Error("listener failure");
        });
        const second = vi.fn();
        client.events.subscribe("changed", first);
        const unsubscribe = client.events.subscribe(
            "changed",
            second
        );
        const server = coordination.serve(
            "test.v1",
            handlers()
        );

        server.events.publish("changed", { value: "one" });
        expect(first).toHaveBeenCalledWith({ value: "one" });
        expect(second).toHaveBeenCalledWith({ value: "one" });
        unsubscribe();
        server.events.publish("changed", { value: "two" });
        expect(second).toHaveBeenCalledOnce();
        await coordination.close();
    });

    it("runs one FIFO lane per service", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "lanes",
        });
        const gate = promiseWithResolvers<void>();
        const order: string[] = [];
        let active = 0;
        let maxActive = 0;
        coordination.serve<TestService>("a.v1", {
            ...handlers(),
            pause: async ({ value }) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                order.push(`start:${value}`);
                if (value === "first") await gate.promise;
                order.push(`end:${value}`);
                active -= 1;
                return value;
            },
        });
        coordination.serve<TestService>("b.v1", {
            ...handlers(),
            echo: ({ value }) => {
                order.push(`other:${value}`);
                return value;
            },
        });
        const a = coordination.service<TestService>("a.v1");
        const b = coordination.service<TestService>("b.v1");

        const first = a.methods.pause({ value: "first" });
        const second = a.methods.pause({ value: "second" });
        await expect(
            b.methods.echo({ value: "parallel" })
        ).resolves.toBe("parallel");
        expect(order).toEqual([
            "start:first",
            "other:parallel",
        ]);
        gate.resolve();
        await expect(
            Promise.all([first, second])
        ).resolves.toEqual(["first", "second"]);
        expect(order).toEqual([
            "start:first",
            "other:parallel",
            "end:first",
            "start:second",
            "end:second",
        ]);
        expect(maxActive).toBe(1);
        await coordination.close();
    });

    it("rejects cyclic cross-service calls", async () => {
        const cyclic = new SingleProcessCoordination({
            scope: "cyclic",
        });
        cyclic.serve<TestService>("a.v1", {
            ...handlers(),
            nested: (_input, context) =>
                context.coordination
                    .service<TestService>("b.v1")
                    .methods.nested({ value: 1 }),
        });
        cyclic.serve<TestService>("b.v1", {
            ...handlers(),
            nested: (_input, context) =>
                context.coordination
                    .service<TestService>("a.v1")
                    .methods.nested({ value: 2 }),
        });
        await expect(
            cyclic
                .service<TestService>("a.v1")
                .methods.nested({ value: 0 })
        ).rejects.toMatchObject({
            code: "CYCLIC_SERVICE_CALL",
        });
        await cyclic.close();
    });

    it("executes a finite same-service nested call reentrantly", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "reentrant",
        });
        coordination.serve<TestService>("test.v1", {
            ...handlers(),
            nested: ({ value }, context) =>
                value === 0
                    ? context.coordination
                          .service<TestService>("test.v1")
                          .methods.nested({ value: 1 })
                    : value,
        });

        await expect(
            coordination
                .service<TestService>("test.v1")
                .methods.nested({ value: 0 })
        ).resolves.toBe(1);
        await coordination.close();
    });

    it("rejects duplicate, unavailable, and closed services", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "registry",
        });
        const server = coordination.serve(
            "test.v1",
            handlers()
        );
        expect(() =>
            coordination.serve("test.v1", handlers())
        ).toThrowError(CoordinationServiceError);
        await expect(
            coordination
                .service<TestService>("missing.v1")
                .methods.echo({ value: "no" })
        ).rejects.toMatchObject({
            code: "SERVICE_UNAVAILABLE",
        });
        await server.close();
        await expect(
            coordination
                .service<TestService>("test.v1")
                .methods.echo({ value: "no" })
        ).rejects.toMatchObject({
            code: "SERVICE_UNAVAILABLE",
        });
        await coordination.close();
    });

    it("cancels active work and waits for cleanup", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "cancel",
        });
        const started = promiseWithResolvers<void>();
        const cleaned = promiseWithResolvers<void>();
        coordination.serve<TestService>("test.v1", {
            ...handlers(),
            pause: async (_input, context) => {
                started.resolve();
                await new Promise<void>((resolve) => {
                    context.signal.addEventListener(
                        "abort",
                        () => resolve(),
                        { once: true }
                    );
                });
                cleaned.resolve();
                return "clean";
            },
        });
        const controller = new AbortController();
        const call = coordination
            .service<TestService>("test.v1")
            .methods.pause(
                { value: "wait" },
                { signal: controller.signal }
            );
        await started.promise;
        controller.abort();
        await expect(call).rejects.toMatchObject({
            name: "AbortError",
        });
        await expect(cleaned.promise).resolves.toBeUndefined();
        await coordination.close();
    });

    it("closes active and queued service work deterministically", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "service-close",
        });
        const started = promiseWithResolvers<void>();
        const cleaned = promiseWithResolvers<void>();
        const server = coordination.serve<TestService>(
            "test.v1",
            {
                ...handlers(),
                pause: async ({ value }, context) => {
                    started.resolve();
                    await new Promise<void>((resolve) =>
                        context.signal.addEventListener(
                            "abort",
                            () => resolve(),
                            { once: true }
                        )
                    );
                    cleaned.resolve();
                    return value;
                },
            }
        );
        const client =
            coordination.service<TestService>("test.v1");
        const active = client.methods.pause({
            value: "active",
        });
        const queued = client.methods.pause({
            value: "queued",
        });
        const activeResult = expect(active).rejects.toMatchObject({
            code: "SERVICE_CLOSED",
        });
        const queuedResult = expect(queued).rejects.toMatchObject({
            code: "SERVICE_CLOSED",
        });
        await started.promise;

        await server.close();

        await activeResult;
        await queuedResult;
        await expect(cleaned.promise).resolves.toBeUndefined();
        await coordination.close();
    });

    it("does not start already-cancelled leader work", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "cancelled-leader",
        });
        const controller = new AbortController();
        const callback = vi.fn();
        controller.abort();

        await expect(
            coordination.runAsLeader(callback, {
                signal: controller.signal,
            })
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(callback).not.toHaveBeenCalled();
        await coordination.close();
    });

    it("aborts leader work and waits for its cleanup on close", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "leader",
        });
        const started = promiseWithResolvers<void>();
        const cleaned = promiseWithResolvers<void>();
        const leader = coordination.runAsLeader(
            async ({ signal }) => {
                started.resolve();
                await new Promise<void>((resolve) =>
                    signal.addEventListener(
                        "abort",
                        () => resolve(),
                        {
                            once: true,
                        }
                    )
                );
                await Promise.resolve();
                cleaned.resolve();
                return "done";
            }
        );
        await started.promise;

        await coordination.close();

        await expect(cleaned.promise).resolves.toBeUndefined();
        await expect(leader).rejects.toMatchObject({
            code: "CLOSED",
        });
        await expect(
            coordination
                .service<TestService>("test.v1")
                .methods.echo({ value: "closed" })
        ).rejects.toMatchObject({ code: "CLOSED" });
    });
});
