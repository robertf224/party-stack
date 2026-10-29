import { Effect, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { makeNetworkConnectivity } from "./NetworkConnectivity.js";

test("slow connectivity subscribers retain the latest state without accumulating transitions", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const state = yield* makeNetworkConnectivity(false);
                const pull = yield* Stream.toPull(state.changes);
                expect(yield* pull).toEqual([false]);
                for (let i = 0; i < 1001; i++) yield* state.set(i % 2 === 0);
                expect(yield* state.online).toBe(true);
                expect(yield* pull).toEqual([true]);
            })
        )
    );
});
