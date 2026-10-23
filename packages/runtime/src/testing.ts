/** Explicit test boundaries for suites that drive scoped services from Promise-based assertions. */
import { Effect, Exit, Scope } from "effect";
import { MemoryBlobBytesStore } from "./memory/MemoryBlobBytesStore.js";
import { Runtime, getRuntime } from "./Runtime.js";
import type { RuntimeAdapter, RuntimeService } from "./index.js";

type Fixture = RuntimeAdapter & { cleanup(): Promise<void>; destroy(): Promise<void> };
const scopes = new WeakMap<RuntimeAdapter, Scope.Closeable>();
const bridges = new WeakMap<
    RuntimeAdapter,
    {
        runtime: { runPromise: ReturnType<typeof Effect.runPromiseWith<Runtime>> };
        traces: RuntimeService["traces"];
    }
>();

function fixture(service: RuntimeService, scope: Scope.Closeable): Fixture {
    const adapter = service.adapter;
    scopes.set(adapter, scope);
    let closing: Promise<void> | undefined;
    let destroying: Promise<void> | undefined;
    const remove = adapter.destroy;
    return Object.assign(adapter, {
        cleanup: () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void))),
        destroy: () =>
            (destroying ??= (closing ??= Effect.runPromise(Scope.close(scope, Exit.void))).then(() =>
                remove?.()
            )),
    });
}
export function defineRuntimeFixture(provider: (owner: string, namespace: string) => RuntimeAdapter) {
    return (owner: string, namespace: string) => {
        const scope = Effect.runSync(Scope.make());
        const adapter = provider(owner, namespace);
        return fixture(Effect.runSync(Scope.provide(Runtime.make(adapter), scope)), scope);
    };
}
export const memoryRuntimeFixture = defineRuntimeFixture((owner, namespace) => ({
    owner,
    namespace,
    blobBytes: new MemoryBlobBytesStore(),
}));
export async function acquireRuntime<E>(
    effect: Effect.Effect<RuntimeService, E, Scope.Scope>
): Promise<Fixture> {
    const scope = Effect.runSync(Scope.make());
    try {
        return fixture(await Effect.runPromise(Scope.provide(effect, scope)), scope);
    } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
        throw cause;
    }
}
export function runtimeFixtureContext(adapter: RuntimeAdapter) {
    let service: RuntimeService;
    try {
        service = getRuntime(adapter);
    } catch {
        if (scopes.has(adapter)) throw new Error("Runtime is closed.");
        const scope = Effect.runSync(Scope.make());
        fixture(Effect.runSync(Scope.provide(Runtime.make(adapter), scope)), scope);
        service = getRuntime(adapter);
    }
    let bridge = bridges.get(adapter);
    if (!bridge) {
        bridge = { runtime: { runPromise: Effect.runPromiseWith(service.context) }, traces: service.traces };
        bridges.set(adapter, bridge);
    }
    return bridge;
}
export const closeRuntimeFixture = (adapter: RuntimeAdapter) => {
    const scope = scopes.get(adapter);
    return scope ? Effect.runPromise(Scope.close(scope, Exit.void)) : Promise.resolve();
};

/** Adapt a synchronous test capability factory to the production scoped provider contract. */
export const asProvider =
    (
        provider: (
            owner: string,
            namespace: string
        ) => RuntimeAdapter & { cleanup?: () => void | Promise<void> }
    ) =>
    (owner: string, namespace: string) =>
        Effect.gen(function* () {
            const adapter = yield* Effect.acquireRelease(
                Effect.sync(() => provider(owner, namespace)),
                (value) =>
                    Effect.promise(async () => {
                        await value.cleanup?.();
                    })
            );
            return yield* Runtime.make(adapter);
        });
