import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { getRuntime } from "@party-stack/runtime";
import { Effect, Exit, Fiber, Scope } from "effect";
import { makeBlobManager, type BlobManagerService } from "./BlobManager.js";
import type { BlobManager, BlobManagerOptions } from "./types.js";
import type { BackendError } from "@party-stack/ontology-backend";

/** Application SDK bridge. Native hosts acquire makeBlobManager directly. */
export function blobManagerClient(
    service: BlobManagerService,
    run: <A>(effect: Effect.Effect<A, BackendError>, signal?: AbortSignal) => Promise<A>,
    cleanup: () => Promise<void> = () => Promise.resolve()
): BlobManager {
    return {
        storage: Promise.resolve(service.storage),
        ready: Promise.resolve(),
        stage: (id, input) => run(service.stage(id, input)),
        bindRemoteId: (id, remoteId) => run(service.bindRemoteId(id, remoteId)),
        source: (id, options) => run(service.source(id, options), options?.signal),
        read: (id, options) => run(service.read(id, options), options?.signal),
        metadata: (id, options) => run(service.metadata(id, options), options?.signal),
        cleanup,
    };
}

export function createBlobManager(options: BlobManagerOptions): BlobManager {
    const runtime = getRuntime(options.runtime);
    const owner = Effect.runSync(Scope.fork(runtime.scope));
    if (options.scope) Effect.runSync(Scope.addFinalizer(options.scope, Scope.close(owner, Exit.void)));
    const run = Effect.runPromiseWith(runtime.context);
    const initialized = run(
        Effect.flatMap(
            Effect.forkIn(
                Scope.provide(
                    makeBlobManager({
                        gcTime: options.gcTime,
                        remote: {
                            read: (id, settings) =>
                                Effect.tryPromise({
                                    try: (signal) =>
                                        options.remote.read(id, {
                                            ...settings,
                                            signal: settings?.signal
                                                ? AbortSignal.any([settings.signal, signal])
                                                : signal,
                                        }),
                                    catch: (cause) => classifyBackendFailure("attachment.read", cause),
                                }),
                            metadata: options.remote.metadata
                                ? (id, settings) =>
                                      Effect.tryPromise({
                                          try: (signal) =>
                                              options.remote.metadata!(id, {
                                                  ...settings,
                                                  signal: settings?.signal
                                                      ? AbortSignal.any([settings.signal, signal])
                                                      : signal,
                                              }),
                                          catch: (cause) =>
                                              classifyBackendFailure("attachment.metadata", cause),
                                      })
                                : undefined,
                        },
                    }),
                    owner
                ),
                owner
            ),
            Fiber.join
        )
    );
    let closing: Promise<void> | undefined;
    const cleanup = () => (closing ??= Effect.runPromise(Scope.close(owner, Exit.void)));
    const client = initialized.then((service) =>
        blobManagerClient(service, (effect, signal) => run(effect, { signal }), cleanup)
    );
    const storage = initialized.then((service) => service.storage);
    const ready = initialized.then(() => undefined);
    void client.catch(() => undefined);
    void storage.catch(() => undefined);
    void ready.catch(() => undefined);
    return {
        storage,
        ready,
        cleanup,
        stage: async (id, input) => (await client).stage(id, input),
        bindRemoteId: async (id, remoteId) => (await client).bindRemoteId(id, remoteId),
        source: async (id, settings) => (await client).source(id, settings),
        read: async (id, settings) => (await client).read(id, settings),
        metadata: async (id, settings) => (await client).metadata(id, settings),
    };
}
