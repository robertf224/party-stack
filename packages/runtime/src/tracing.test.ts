import { Cause, Effect, Tracer } from "effect";
import { expect, test } from "vite-plus/test";
import { createTraceCapture, makeTraceCapture } from "./tracing.js";

test("recording is opt-in and a live feed retains no completed history", async () => {
    expect(await Effect.runPromise(makeTraceCapture())).toBeUndefined();
    const capture = (await Effect.runPromise(makeTraceCapture("live")))!;
    const first: string[] = [];
    const stop = capture.subscribe((record) => {
        if (record) first.push(record.outcome);
    });
    await Effect.runPromise(
        Effect.void.pipe(Effect.withSpan("one"), Effect.provideService(Tracer.Tracer, capture.tracer))
    );
    expect(first).toEqual(["running", "success"]);
    expect(capture.getSnapshot()).toEqual([]);
    stop();
    const second: string[] = [];
    const stopSecond = capture.subscribe((record) => {
        if (record) second.push(record.name);
    });
    expect(second).toEqual([]);
    await Effect.runPromise(
        Effect.void.pipe(Effect.withSpan("two"), Effect.provideService(Tracer.Tracer, capture.tracer))
    );
    expect(first).toEqual(["running", "success"]);
    expect(second).toEqual(["two", "two"]);
    expect(capture.getSnapshot()).toEqual([]);
    stopSecond();
});

test("devtools capture preserves the configured tracer and its unfiltered events", async () => {
    const exported: Tracer.NativeSpan[] = [];
    const exporter = Tracer.make({
        span(options) {
            const span = new Tracer.NativeSpan(options);
            exported.push(span);
            return span;
        },
    });
    const capture = await Effect.runPromise(
        Effect.gen(function* () {
            const capture = (yield* makeTraceCapture("buffer"))!;
            yield* Effect.gen(function* () {
                const span = yield* Effect.currentSpan;
                span.event("exporter.event", 0n, { private: "exporter-only" });
                span.event("visible.event", 1n, { diagnostic: true, count: 1 });
            }).pipe(Effect.withSpan("sync"), Effect.provideService(Tracer.Tracer, capture.tracer));
            return capture;
        }).pipe(Effect.provideService(Tracer.Tracer, exporter))
    );
    expect(exported).toHaveLength(1);
    expect(exported[0]?.status._tag).toBe("Ended");
    expect(exported[0]?.events.map(([name]) => name)).toEqual(["exporter.event", "visible.event"]);
    expect(capture.getSnapshot()[0]?.events?.map((event) => event.name)).toEqual(["visible.event"]);
    expect(JSON.stringify(capture.getSnapshot())).not.toContain("exporter-only");
});

test("trace outcomes distinguish normal interruption from errors, defects, and mixed causes", async () => {
    const traces = createTraceCapture();
    const run = (name: string, work: Effect.Effect<unknown, unknown>) =>
        Effect.runPromiseExit(
            work.pipe(
                Effect.withSpan(name, { attributes: { activity: "subscription" } }),
                Effect.provideService(Tracer.Tracer, traces.tracer)
            )
        );
    await run("closed", Effect.void);
    await run("stopped", Effect.interrupt);
    await run("error", Effect.fail(new Error("Connection refused")));
    await run("defect", Effect.die(new Error("Unexpected state")));
    await run(
        "mixed",
        Effect.failCause(Cause.combine(Cause.interrupt(), Cause.fail(new Error("Finalizer failed"))))
    );
    expect(traces.getSnapshot().map((trace) => [trace.name, trace.outcome, trace.error])).toEqual([
        ["closed", "success", undefined],
        ["stopped", "interrupted", undefined],
        ["error", "failure", { kind: "Error", message: "Connection refused" }],
        ["defect", "failure", { kind: "Defect", message: "Unexpected state" }],
        ["mixed", "failure", { kind: "Error", message: "Finalizer failed" }],
    ]);
});

test("trace failures retain a bounded message without copying stacks, payloads, or cause objects", async () => {
    const traces = createTraceCapture();
    const record = (name: string, error: unknown) =>
        Effect.runPromiseExit(
            Effect.fail(error).pipe(
                Effect.withSpan(name),
                Effect.provideService(Tracer.Tracer, traces.tracer)
            )
        );
    await record("long", new Error("x".repeat(2000), { cause: { token: "secret-token" } }));
    await record("payload", { message: "secret-token", parameters: "secret-token" });
    expect(traces.getSnapshot()[0]?.error?.message).toHaveLength(500);
    expect(traces.getSnapshot()[1]?.error?.message).toBe("Error details were not recorded.");
    expect(JSON.stringify(traces.getSnapshot())).not.toContain("secret-token");
    expect(JSON.stringify(traces.getSnapshot())).not.toContain("stack");
});

test("Effect trace buffer is bounded and omits parameters and secret attributes", async () => {
    const traces = createTraceCapture(2);
    for (const index of [1, 2, 3])
        await Effect.runPromise(
            Effect.void.pipe(
                Effect.withSpan(`Replica.test${index}`, {
                    attributes: { count: index, token: "secret-token" },
                }),
                Effect.provideService(Tracer.Tracer, traces.tracer)
            )
        );
    expect(traces.getSnapshot().map((entry) => entry.name)).toEqual(["Replica.test2", "Replica.test3"]);
    expect(traces.getSnapshot()[0]?.attributes).toEqual({ count: 2 });
    expect(JSON.stringify(traces.getSnapshot())).not.toContain("secret-token");
    const single = createTraceCapture(1);
    for (const _ of [1, 2]) {
        void _;
        await Effect.runPromise(
            Effect.void.pipe(Effect.withSpan("one"), Effect.provideService(Tracer.Tracer, single.tracer))
        );
    }
    expect(single.getSnapshot()).toHaveLength(1);
});

test("running spans retain their parent and clearing does not resurrect in-flight work", async () => {
    const { Deferred, Fiber } = await import("effect");
    const traces = createTraceCapture();
    const gate = Effect.runSync(Deferred.make<void>());
    const fiber = Effect.runFork(
        Deferred.await(gate).pipe(
            Effect.withSpan("child"),
            Effect.withSpan("sync"),
            Effect.provideService(Tracer.Tracer, traces.tracer)
        )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root = traces.getSnapshot().find((span) => span.name === "sync")!;
    const child = traces.getSnapshot().find((span) => span.name === "child")!;
    expect(root.outcome).toBe("running");
    expect(child.parentId).toBe(root.id);
    expect(child.traceId).toBe(root.traceId);
    traces.clear();
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await Effect.runPromise(Fiber.join(fiber));
    expect(traces.getSnapshot()).toEqual([]);
});

test("subscription messages update live, remain bounded, and exclude arbitrary events and attributes", async () => {
    const traces = createTraceCapture();
    await Effect.runPromise(
        Effect.gen(function* () {
            const span = yield* Effect.currentSpan;
            expect(traces.getSnapshot()[0]?.attributes).toEqual({ activity: "subscription" });
            for (let count = 0; count < 150; count++)
                span.event("transfer.progress", 1_000_000n * BigInt(count), {
                    diagnostic: true,
                    count,
                    token: "secret",
                });
            span.event("secret-event", 0n, { token: "secret" });
            const record = traces.getSnapshot()[0]!;
            expect(record.outcome).toBe("running");
            expect(record.eventCount).toBe(150);
            expect(record.events).toHaveLength(100);
            expect(record.events?.[0]).toEqual({
                name: "transfer.progress",
                at: 50,
                attributes: { count: 50 },
            });
        }).pipe(
            Effect.withSpan("watch", { attributes: { activity: "subscription" } }),
            Effect.provideService(Tracer.Tracer, traces.tracer)
        )
    );
    expect(traces.getSnapshot()[0]?.eventCount).toBe(150);
    expect(traces.getSnapshot()[0]?.outcome).toBe("success");
    expect(JSON.stringify(traces.getSnapshot())).not.toContain("secret");
});
