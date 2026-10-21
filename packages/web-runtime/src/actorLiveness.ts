import { RuntimeError } from "@party-stack/runtime";
import { Effect } from "effect";
import type { RuntimeAdapter } from "@party-stack/runtime";

/** Web Locks release automatically on page/process termination, including an ungraceful reload. */
export function createActorLiveness(
    namespace: string,
    locks: LockManager = navigator.locks
): NonNullable<RuntimeAdapter["actorLiveness"]> {
    const name = (owner: string) => JSON.stringify(["party-stack", namespace, "storage-owner", owner]);
    return {
        acquire: (owner) =>
            Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                    const lease = yield* Effect.acquireRelease(
                        Effect.try({
                            try: () => {
                                const controller = new AbortController();
                                let release!: () => void;
                                const held = new Promise<void>((resolve) => {
                                    release = resolve;
                                });
                                let accept!: () => void;
                                let reject!: (cause: unknown) => void;
                                const ready = new Promise<void>((resolve, failed) => {
                                    accept = resolve;
                                    reject = failed;
                                });
                                void ready.catch(() => undefined);
                                const finished = locks.request(
                                    name(owner),
                                    { mode: "exclusive", signal: controller.signal },
                                    async () => {
                                        accept();
                                        await held;
                                    }
                                );
                                void finished.catch(reject);
                                return { controller, release, ready, finished };
                            },
                            catch: (cause) => new RuntimeError({ operation: "storage.owner.acquire", cause }),
                        }),
                        (lease) =>
                            Effect.promise(async () => {
                                lease.release();
                                lease.controller.abort();
                                await lease.finished.catch(() => undefined);
                            })
                    );
                    yield* restore(
                        Effect.tryPromise({
                            try: () => lease.ready,
                            catch: (cause) => new RuntimeError({ operation: "storage.owner.acquire", cause }),
                        })
                    );
                })
            ),
        isAlive: (owner) =>
            Effect.tryPromise({
                try: async () =>
                    (await locks.query()).held?.some((lock) => lock.name === name(owner)) ?? true,
                catch: (cause) => new RuntimeError({ operation: "storage.owner.query", cause }),
            }),
    };
}
