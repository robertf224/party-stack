import { Effect, Exit, Scope } from "effect";
import { expect, test } from "vite-plus/test";
import { createActorLiveness } from "./actorLiveness.js";

test("storage owner locks survive while scoped and release before cleanup completes", async () => {
    const held = new Set<string>();
    const locks = {
        request: async (name: string, _options: unknown, body: () => Promise<void>) => {
            held.add(name);
            try {
                await body();
            } finally {
                held.delete(name);
            }
        },
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
    } as unknown as LockManager;
    const owners = createActorLiveness("test", locks);
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(Scope.provide(owners.acquire("one"), scope));
    expect(await Effect.runPromise(owners.isAlive("one"))).toBe(true);
    expect(await Effect.runPromise(owners.isAlive("other"))).toBe(false);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(await Effect.runPromise(owners.isAlive("one"))).toBe(false);
});
