/** Test boundaries for driving scoped services from Promise-based assertions. */
import { Context, Effect, Exit, Layer, Scope, Tracer } from "effect";
import { MemoryBlobBytesStore } from "./memory/MemoryBlobBytesStore.js";
import { Runtime, RuntimeError } from "./Runtime.js";
import { RuntimePartition } from "./RuntimePartition.js";
import type { RuntimeOptions, RuntimeService } from "./index.js";

export type RuntimeFixtureOptions = Omit<RuntimeOptions, "destroy"> & {
    readonly owner: string;
    readonly namespace: string;
    readonly destroy?: RuntimeOptions["destroy"] | (() => void | Promise<void>);
};
export type RuntimeFixture = Omit<RuntimeFixtureOptions, "destroy"> & {
    cleanup(): Promise<void>;
    destroy(): Promise<void>;
};
const optionsByFixture = new WeakMap<object, RuntimeFixtureOptions>();
const states = new WeakMap<
    object,
    { service: RuntimeService; scope: Scope.Closeable; closed: boolean; closing?: Promise<void> }
>();
const bridges = new WeakMap<
    object,
    {
        service: RuntimeService;
        scope: Scope.Closeable;
        runtime: { runPromise: ReturnType<typeof Effect.runPromiseWith<Runtime>> };
        traces: RuntimeService["traces"];
    }
>();
const optionsFor = (value: RuntimeFixtureOptions): RuntimeOptions => {
    const original = optionsByFixture.get(value) ?? value;
    const destroy = original.destroy;
    return {
        ...original,
        destroy:
            typeof destroy === "function"
                ? Effect.tryPromise({
                      try: async () => {
                          await destroy();
                      },
                      catch: (cause) => new RuntimeError({ operation: "destroy", cause }),
                  })
                : destroy,
    };
};
export const makeTestRuntime = (options: RuntimeFixtureOptions) =>
    Runtime.make(optionsFor(options)).pipe(
        Effect.provideService(RuntimePartition, { owner: options.owner, namespace: options.namespace })
    );
function fixture(options: RuntimeFixtureOptions): RuntimeFixture {
    let destroying: Promise<void> | undefined;
    const value = {
        ...options,
        cleanup: () => closeRuntimeFixture(value),
        destroy: () =>
            (destroying ??= closeRuntimeFixture(value).then(() =>
                Effect.runPromise(optionsFor(value).destroy ?? Effect.void)
            )),
    };
    optionsByFixture.set(value, options);
    return value;
}
export function defineRuntimeFixture(provider: (owner: string, namespace: string) => RuntimeFixtureOptions) {
    return (owner: string, namespace: string) => fixture(provider(owner, namespace));
}
export const memoryRuntimeFixture = defineRuntimeFixture((owner, namespace) => ({
    owner,
    namespace,
    blobBytes: new MemoryBlobBytesStore(),
}));
export async function acquireRuntime<E>(
    effect: Effect.Effect<RuntimeService, E, Scope.Scope>
): Promise<RuntimeFixture> {
    const scope = Effect.runSync(Scope.make());
    try {
        const service = await Effect.runPromise(Scope.provide(effect, scope));
        const value = fixture({
            owner: service.owner,
            namespace: service.namespace,
            tables: Effect.succeed(service.tables),
            encryptionKeyring: service.encryptionKeyring
                ? Effect.succeed(service.encryptionKeyring)
                : undefined,
            browserAuthentication: service.browserAuthentication,
            blobBytes: service.bytes,
            destroy: service.destroy,
        });
        states.set(value, { service, scope, closed: false });
        return value;
    } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
        throw cause;
    }
}
export function runtimeFixtureContext(value: RuntimeFixtureOptions) {
    let state = states.get(value);
    if (state?.closed) throw new Error("Runtime is closed.");
    if (!state) {
        const scope = Effect.runSync(Scope.make());
        const service = Effect.runSync(
            Scope.provide(
                Runtime.make(optionsFor(value)).pipe(
                    Effect.provideService(RuntimePartition, {
                        owner: value.owner,
                        namespace: value.namespace,
                    })
                ),
                scope
            )
        );
        state = { service, scope, closed: false };
        states.set(value, state);
    }
    let bridge = bridges.get(value);
    if (!bridge) {
        bridge = {
            service: state.service,
            scope: state.scope,
            runtime: {
                runPromise: Effect.runPromiseWith(
                    Context.make(Runtime, state.service).pipe(
                        Context.add(Tracer.Tracer, state.service.traces.tracer)
                    )
                ),
            },
            traces: state.service.traces,
        };
        bridges.set(value, bridge);
    }
    return bridge;
}
export const closeRuntimeFixture = (value: object) => {
    const state = states.get(value);
    if (!state) return Promise.resolve();
    if (state.closing) return state.closing;
    state.closed = true;
    return (state.closing = Effect.runPromise(Scope.close(state.scope, Exit.void)));
};
/** Test Layers supply the same service contract as native platform Layers. */
export const asRuntimeLayer = (
    provider: (
        owner: string,
        namespace: string
    ) => RuntimeFixtureOptions & { cleanup?: () => void | Promise<void> }
) =>
    Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const partition = yield* RuntimePartition;
            const value = yield* Effect.acquireRelease(
                Effect.sync(() => provider(partition.owner, partition.namespace)),
                (value) =>
                    Effect.promise(async () => {
                        await value.cleanup?.();
                    })
            );
            const existing = states.get(value);
            if (existing && !existing.closed) return existing.service;
            return yield* Runtime.make(optionsFor(value));
        })
    );
