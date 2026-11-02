import { Effect, Exit, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { makeNavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";

afterEach(() => vi.unstubAllGlobals());
const setup = Effect.fnUntraced(function* (initiallyOnline = false, worker = false) {
    let online = initiallyOnline;
    const target = new EventTarget();
    const remove = vi.spyOn(target, "removeEventListener");
    vi.stubGlobal("window", worker ? undefined : target);
    if (worker) {
        vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
        vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
    }
    vi.stubGlobal("navigator", {
        get onLine() {
            return online;
        },
    });
    const connectivity = yield* makeNavigatorNetworkConnectivity();
    const values: boolean[] = [];
    yield* Stream.runForEach(connectivity.changes, (value) =>
        Effect.sync(() => {
            values.push(value);
        })
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust(0);
    return {
        connectivity,
        values,
        remove,
        setOnline: (value: boolean, dispatch = true) => {
            online = value;
            if (dispatch) target.dispatchEvent(new Event(value ? "online" : "offline"));
        },
    };
});
test("workers detect connectivity changes without native events, including briefly observed offline periods", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { connectivity, setOnline, values } = yield* setup(true, true);
                setOnline(false, false);
                // An outbox can observe offline before the platform's next sample.
                expect(yield* connectivity.online).toBe(false);
                yield* TestClock.adjust(100);
                setOnline(true, false);
                yield* TestClock.adjust(1_899);
                expect(values).toEqual([true, false]);
                yield* TestClock.adjust(1);
                expect(values).toEqual([true, false, true]);
                expect(yield* connectivity.online).toBe(true);
                setOnline(false, false);
                yield* TestClock.adjust(1_000);
                expect(values).toEqual([true, false, true, false]);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
test("connectivity emits its initial state and waits for an online connection to stabilize", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { connectivity, setOnline, values } = yield* setup();
                expect(values).toEqual([false]);
                setOnline(true);
                yield* TestClock.adjust(999);
                expect(yield* connectivity.online).toBe(false);
                yield* TestClock.adjust(1);
                expect(yield* connectivity.online).toBe(true);
                expect(values).toEqual([false, true]);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
test("going offline cancels pending stabilization", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { connectivity, setOnline, values } = yield* setup();
                setOnline(true);
                yield* TestClock.adjust(500);
                setOnline(false);
                yield* TestClock.adjust(1000);
                expect(yield* connectivity.online).toBe(false);
                expect(values).toEqual([false]);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
test("closing the platform scope removes listeners and cancels stabilization", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const scope = yield* Scope.fork(yield* Effect.scope);
                const { setOnline, remove, values } = yield* Scope.provide(setup(), scope);
                setOnline(true);
                yield* TestClock.adjust(100);
                yield* Scope.close(scope, Exit.void);
                yield* TestClock.adjust(1000);
                expect(remove.mock.calls.map(([event]) => event).sort()).toEqual(["offline", "online"]);
                expect(values).toEqual([false]);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});
