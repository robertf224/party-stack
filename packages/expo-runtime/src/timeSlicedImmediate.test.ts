import { describe, expect, it } from "vite-plus/test";
import { makeTimeSlicedImmediate } from "./timeSlicedImmediate.js";

const harness = (budgetMs = 8) => {
    let time = 0;
    const microtasks: (() => void)[] = [];
    const timers: { task: () => void; cancelled: boolean }[] = [];
    const immediate = makeTimeSlicedImmediate({
        budgetMs,
        now: () => time,
        queueMicrotask: (task) => microtasks.push(task),
        setTimeout: (task) => {
            const timer = { task, cancelled: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            (timer as { cancelled: boolean }).cancelled = true;
        },
    });
    const drainMicrotasks = () => {
        while (microtasks.length) microtasks.shift()!();
    };
    const turn = () => {
        drainMicrotasks();
        for (const timer of timers.splice(0)) if (!timer.cancelled) timer.task();
        drainMicrotasks();
    };
    return {
        ...immediate,
        advance: (ms: number) => (time += ms),
        microtasks,
        timers,
        drainMicrotasks,
        turn,
    };
};

describe("time-sliced immediates", () => {
    it("runs immediates as microtasks within a slice, then defers to the event loop", () => {
        const h = harness();
        const ran: string[] = [];
        h.setImmediate(() => ran.push("first"));
        h.drainMicrotasks();
        expect(ran).toEqual(["first"]);
        h.advance(10);
        h.setImmediate(() => ran.push("deferred"));
        h.drainMicrotasks();
        // The slice is exhausted: a host turn must run before the next immediate.
        expect(ran).toEqual(["first"]);
        h.turn();
        expect(ran).toEqual(["first", "deferred"]);
        // A completed host turn starts a new slice.
        h.setImmediate(() => ran.push("next slice"));
        h.drainMicrotasks();
        expect(ran).toEqual(["first", "deferred", "next slice"]);
    });

    it("cancels pending immediates in either mode and passes arguments", () => {
        const h = harness();
        const ran: unknown[] = [];
        const micro = h.setImmediate((value) => ran.push(value), "micro");
        h.clearImmediate(micro);
        h.advance(10);
        const timer = h.setImmediate((value) => ran.push(value), "timer");
        h.clearImmediate(timer);
        h.setImmediate((value) => ran.push(value), "kept");
        h.turn();
        expect(ran).toEqual(["kept"]);
        h.clearImmediate(undefined);
    });
});
