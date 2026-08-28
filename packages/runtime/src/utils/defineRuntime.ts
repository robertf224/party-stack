import type {
    RuntimeAdapter,
    RuntimeAdapterProvider,
} from "../types.js";

type SyncRuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => RuntimeAdapter;

type AsyncRuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => Promise<RuntimeAdapter>;

function manageRuntime(
    runtime: RuntimeAdapter
): RuntimeAdapter {
    const rawCleanup =
        runtime.cleanup?.bind(runtime);
    const rawDestroy =
        runtime.destroy?.bind(runtime);
    let cleanupPromise: Promise<void> | undefined;
    let destroyPromise: Promise<void> | undefined;

    const cleanup = (): Promise<void> => {
        cleanupPromise ??= Promise.resolve()
            .then(() => rawCleanup?.())
            .then(() => undefined);
        return cleanupPromise;
    };
    const destroy = rawDestroy
        ? (): Promise<void> => {
              destroyPromise ??= cleanup()
                  .then(() => rawDestroy())
                  .then(() => undefined);
              return destroyPromise;
          }
        : undefined;

    return {
        ...runtime,
        cleanup,
        destroy,
    };
}

export function defineRuntime(
    provider: SyncRuntimeAdapterProvider
): SyncRuntimeAdapterProvider;
export function defineRuntime(
    provider: AsyncRuntimeAdapterProvider
): AsyncRuntimeAdapterProvider;
export function defineRuntime(
    provider: RuntimeAdapterProvider
): RuntimeAdapterProvider {
    return (owner, namespace) => {
        const runtime = provider(owner, namespace);
        return runtime instanceof Promise
            ? runtime.then(manageRuntime)
            : manageRuntime(runtime);
    };
}
