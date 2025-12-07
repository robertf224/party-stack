import { ObjectSet } from "@osdk/foundry.ontologies";
import { run, Task, until } from "effection";
import { each } from "effection";
import { useValueSignal } from "./effection-utils/useValueSignal.js";
import { ObjectSetSubscription, ObjectSetSubscriptionMessage } from "./ObjectSetSubscription.js";
import { useObjectSetWatcherSession } from "./useObjectSetWatcherSession.js";
import type { Client } from "@osdk/client";

export class ObjectSetWatcherManager {
    #task: Task<void> | undefined;
    #objectSetSubscriptions: Map<string, Set<(data: ObjectSetSubscriptionMessage) => void>>;
    #updateDesiredSubscriptions:
        | ((updater: (state: ObjectSetSubscription[]) => ObjectSetSubscription[]) => void)
        | undefined;

    constructor(client: Client) {
        this.#objectSetSubscriptions = new Map();

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const manager = this;
        this.#task = run(function* () {
            const desiredSubscriptions = yield* useValueSignal<ObjectSetSubscription[]>([]);
            // eslint-disable-next-line @typescript-eslint/unbound-method
            manager.#updateDesiredSubscriptions = desiredSubscriptions.update;
            const messages = yield* useObjectSetWatcherSession(
                client.__osdkClientContext.baseUrl,
                () => until(client.__osdkClientContext.tokenProvider()),
                (client.__osdkClientContext as unknown as { ontologyRid: string }).ontologyRid,
                desiredSubscriptions
            );

            for (const message of yield* each(messages)) {
                if (message.type === "change" || message.type === "refresh") {
                    try {
                        const subscriptions = manager.#objectSetSubscriptions.get(message.subscriptionId);
                        subscriptions?.forEach((sub) => {
                            try {
                                sub(message);
                            } catch (error) {
                                console.error("Error during subscription callback", error);
                            }
                        });
                    } catch (error) {
                        console.error("Some error in change propagation", error);
                    }
                } else {
                    for (const update of message.updates) {
                        const subscriptions = manager.#objectSetSubscriptions.get(update.subscriptionId);
                        subscriptions?.forEach((sub) => {
                            try {
                                sub({ type: "state", status: update.status });
                            } catch (error) {
                                console.error("Error during subscription callback", error);
                            }
                        });
                        if (update.status === "error") {
                            desiredSubscriptions.update((subs) =>
                                subs.filter((sub) => sub.id === update.subscriptionId)
                            );
                        }
                    }
                }
                yield* each.next();
            }
        });
    }

    subscribe(objectSet: ObjectSet, callback: (data: ObjectSetSubscriptionMessage) => void): () => void {
        const key = JSON.stringify(objectSet);
        let existingSubscriptions = this.#objectSetSubscriptions.get(key);
        if (!existingSubscriptions) {
            existingSubscriptions = new Set();
            this.#objectSetSubscriptions.set(key, existingSubscriptions);
            this.#updateDesiredSubscriptions?.((subs) => [
                ...subs,
                { id: key, objectSet, propertySet: [], referenceSet: [] },
            ]);
        }
        existingSubscriptions.add(callback);
        return () => {
            const deleted = existingSubscriptions.delete(callback);
            if (deleted && existingSubscriptions.size === 0) {
                this.#objectSetSubscriptions.delete(key);
                this.#updateDesiredSubscriptions?.((subs) => subs.filter((sub) => sub.id === key));
            }
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

const cache = new WeakMap<Client, ObjectSetWatcherManager>();
export function getObjectSetWatcherManager(client: Client): ObjectSetWatcherManager {
    let manager = cache.get(client);
    if (!manager) {
        manager = new ObjectSetWatcherManager(client);
        cache.set(client, manager);
    }
    return manager;
}
