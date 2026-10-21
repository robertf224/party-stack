import { Cause, Effect, Tracer } from "effect";
import { expect, test } from "vite-plus/test";
import { createRuntimeTraces } from "./tracing.js";

test("trace outcomes distinguish normal interruption from errors, defects, and mixed causes", async () => {
    const traces = createRuntimeTraces();
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
    const traces = createRuntimeTraces();
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
