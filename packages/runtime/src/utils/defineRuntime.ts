import { disposeRuntimeEffects } from "../Runtime.js";
import type { RuntimeAdapter, RuntimeAdapterProvider } from "../types.js";

type SyncRuntimeAdapterProvider = (owner: string, namespace: string) => RuntimeAdapter;

type AsyncRuntimeAdapterProvider = (owner: string, namespace: string) => Promise<RuntimeAdapter>;

function manageRuntime(runtime: RuntimeAdapter): RuntimeAdapter {
    const rawCleanup = runtime.cleanup?.bind(runtime);
    const rawDestroy = runtime.destroy?.bind(runtime);
    let cleanupPromise: Promise<void> | undefined;
    let destroyPromise: Promise<void> | undefined;

    let managed: RuntimeAdapter;
    const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
            const errors: unknown[] = [];
            try {
                await disposeRuntimeEffects(managed);
            } catch (cause) {
                errors.push(cause);
            }
            try {
                await rawCleanup?.();
            } catch (cause) {
                errors.push(cause);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "Runtime cleanup failed.");
        })();
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

    managed = {
        ...runtime,
        cleanup,
        destroy,
    };
    return managed;
}

export function defineRuntime(provider: SyncRuntimeAdapterProvider): SyncRuntimeAdapterProvider;
export function defineRuntime(provider: AsyncRuntimeAdapterProvider): AsyncRuntimeAdapterProvider;
export function defineRuntime(provider: RuntimeAdapterProvider): RuntimeAdapterProvider {
    return (owner, namespace) => {
        const runtime = provider(owner, namespace);
        return runtime instanceof Promise ? runtime.then(manageRuntime) : manageRuntime(runtime);
    };
}
