import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { makeObjectSetWatcher, type ObjectSetWatcherService } from "./ObjectSetWatcher.js";
import type { ObjectSetSubscriptionMessage } from "./types.js";
import type { ObjectSet } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

/** Callback facade over the scoped Effect service. */
export class ObjectSetWatcherManager {
    readonly #scope = Effect.runSync(Scope.make());
    readonly #manager: ObjectSetWatcherService;
    #stopped = false;
    #closing: Promise<void> | undefined;

    constructor(client: OntologyClient) {
        this.#manager = Effect.runSync(Scope.provide(makeObjectSetWatcher(client), this.#scope));
    }

    get stopped(): boolean {
        return this.#stopped;
    }

    subscribe(objectSet: ObjectSet, callback: (data: ObjectSetSubscriptionMessage) => void): () => void {
        if (this.#stopped) throw new Error("ObjectSetWatcherManager is stopped.");
        const fiber = Effect.runSync(
            Effect.forkIn(
                Stream.runForEach(this.#manager.subscribe(objectSet), (message) =>
                    Effect.try({ try: () => callback(message), catch: () => undefined }).pipe(
                        Effect.catch(() => Effect.logError("Object set subscriber callback failed."))
                    )
                ),
                this.#scope
            )
        );
        let cancelled = false;
        return () => {
            if (cancelled) return;
            cancelled = true;
            Effect.runFork(Fiber.interrupt(fiber));
        };
    }

    stop(): Promise<void> {
        this.#stopped = true;
        return (this.#closing ??= Effect.runPromise(Scope.close(this.#scope, Exit.void)));
    }
}
const cache = new WeakMap<OntologyClient, ObjectSetWatcherManager>();
export function getObjectSetWatcherManager(client: OntologyClient): ObjectSetWatcherManager {
    let manager = cache.get(client);
    if (!manager || manager.stopped) {
        manager = new ObjectSetWatcherManager(client);
        cache.set(client, manager);
    }
    return manager;
}
