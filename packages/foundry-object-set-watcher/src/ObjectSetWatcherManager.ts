import { ObjectSet } from "@osdk/foundry.ontologies";
import { each, run, suspend, Task, useScope } from "effection";
import type { OntologyClient } from "@party-stack/foundry-client";
import { ObjectSetSubscriptionMessage } from "./types.js";
import {
    ObjectSetWatcherManager as EffectionObjectSetWatcherManager,
    useObjectSetWatcherManager,
} from "./useObjectSetWatcherManager.js";
import type { Scope } from "effection";

export class ObjectSetWatcherManager {
    #task: Task<void> | undefined;
    #scope: Scope | undefined;
    #manager: EffectionObjectSetWatcherManager | undefined;

    constructor(client: OntologyClient) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const manager = this;
        this.#task = run(function* () {
            manager.#scope = yield* useScope();
            manager.#manager = yield* useObjectSetWatcherManager(client);
            yield* suspend();
        });
    }

    subscribe(objectSet: ObjectSet, callback: (data: ObjectSetSubscriptionMessage) => void): () => void {
        const scope = this.#scope;
        const manager = this.#manager;
        if (!scope || !manager) {
            throw new Error("ObjectSetWatcherManager has not been initialized");
        }

        const task = scope.run(function* () {
            for (const message of yield* each(manager.observe(objectSet))) {
                try {
                    callback(message);
                } catch (error) {
                    console.error("Error during subscription callback", error);
                }
                yield* each.next();
            }
        });

        return () => {
            void task.halt();
        };
    }

    async stop(): Promise<void> {
        if (this.#task) {
            const task = this.#task;
            this.#task = undefined;
            await task.halt();
        }
    }
}

const cache = new WeakMap<OntologyClient, ObjectSetWatcherManager>();
export function getObjectSetWatcherManager(client: OntologyClient): ObjectSetWatcherManager {
    let manager = cache.get(client);
    if (!manager) {
        manager = new ObjectSetWatcherManager(client);
        cache.set(client, manager);
    }
    return manager;
}
