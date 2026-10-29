import { Runtime } from "@party-stack/runtime";
import { BasicIndex, createCollection } from "@tanstack/db";
import { Context, Effect, Exit, Scope } from "effect";
import { localCollectionOptions } from "./collections.js";
import type { RuntimeService } from "@party-stack/runtime";
import type { Collection, CollectionConfig } from "@tanstack/db";

/** Synchronous application boundary; storage acquisition and all work stay in the runtime's scope. */
export function createEffectLocalCollection<A extends object, K extends string | number>(options: {
    name: string;
    getKey: (value: A) => K;
    runtime: RuntimeService;
    schemaVersion?: number;
    scope: Scope.Scope;
}): Collection<A, K> {
    const managed = { runPromise: Effect.runPromiseWith(Context.make(Runtime, options.runtime)) };
    let closed = false;
    let collection: Collection<A, K>;
    let scopeClosing = false;
    const initialized = managed.runPromise(
        Effect.gen(function* () {
            const scope = yield* Scope.fork(options.scope);
            yield* Scope.addFinalizer(
                scope,
                Effect.promise(async () => {
                    if (closed) return;
                    scopeClosing = true;
                    await collection.cleanup();
                })
            );
            const config = yield* Scope.provide(localCollectionOptions<A, K>(options), scope);
            if (closed) yield* Scope.close(scope, Exit.void);
            return { scope, config };
        })
    );
    // Consumers see initialization failures through query and mutation promises.
    void initialized.catch(() => undefined);
    const config: CollectionConfig<A, K> = {
        id: `party-stack:${options.runtime.owner}:${options.runtime.namespace}:${options.name}`,
        getKey: options.getKey,
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        syncMode: "on-demand",
        startSync: true,
        onInsert: async (args) => (await initialized).config.onInsert!(args),
        onUpdate: async (args) => (await initialized).config.onUpdate!(args),
        onDelete: async (args) => (await initialized).config.onDelete!(args),
        sync: {
            sync: (args) => {
                const started = initialized.then(({ config }) => {
                    if (closed) return undefined;
                    return config.sync.sync(args);
                });
                void started.catch(args.markError);
                return {
                    loadSubset: async (subset) => {
                        const sync = await started;
                        if (sync && typeof sync === "object") await sync.loadSubset?.(subset);
                    },
                    unloadSubset: (subset) => {
                        void started.then((sync) => {
                            if (sync && typeof sync === "object") sync.unloadSubset?.(subset);
                        });
                    },
                    cleanup: async () => {
                        closed = true;
                        try {
                            const sync = await started;
                            if (typeof sync === "function") sync();
                            else await sync?.cleanup?.();
                        } finally {
                            const state = await initialized;
                            if (!scopeClosing) await Effect.runPromise(Scope.close(state.scope, Exit.void));
                        }
                    },
                };
            },
        },
    };
    collection = createCollection(config);
    return collection;
}
