/* eslint-disable react-hooks/rules-of-hooks */
import { ObjectSet } from "@osdk/foundry.ontologies";
import { Channel, createChannel, Operation, resource, spawn, Stream, until } from "effection";
import type { OntologyClient } from "@party-stack/foundry-client";
import { useValueSignal } from "./effection-utils/useValueSignal.js";
import { ObjectSetSubscription, ObjectSetSubscriptionMessage } from "./ObjectSetSubscription.js";
import { useObjectSetWatcherSession } from "./useObjectSetWatcherSession.js";
import type { ValueSignal } from "@effectionx/signals";

export interface ObjectSetWatcherManager {
    subscribe: (objectSet: ObjectSet) => Stream<ObjectSetSubscriptionMessage, void>;
}

function ensureDesiredSubscription(
    desiredSubscriptions: ValueSignal<ObjectSetSubscription[]>,
    id: string,
    objectSet: ObjectSet
): void {
    desiredSubscriptions.update((subscriptions) => {
        if (subscriptions.some((subscription) => subscription.id === id)) {
            return subscriptions;
        }

        return [...subscriptions, { id, objectSet, propertySet: [], referenceSet: [] }];
    });
}

function removeDesiredSubscription(
    desiredSubscriptions: ValueSignal<ObjectSetSubscription[]>,
    id: string
): void {
    desiredSubscriptions.update((subscriptions) =>
        subscriptions.filter((subscription) => subscription.id !== id)
    );
}

type SharedSubscription = {
    objectSet: ObjectSet;
    channel: Channel<ObjectSetSubscriptionMessage, void>;
    consumers: number;
};

export function useObjectSetWatcherManager(client: OntologyClient): Operation<ObjectSetWatcherManager> {
    return resource(function* (provide) {
        const desiredSubscriptions = yield* useValueSignal<ObjectSetSubscription[]>([]);
        const sharedSubscriptions = new Map<string, SharedSubscription>();
        const messages = yield* useObjectSetWatcherSession(
            client.baseUrl,
            () => until(client.tokenProvider()),
            client.ontologyRid,
            desiredSubscriptions
        );

        try {
            void (yield* spawn(function* () {
                const subscriptionMessages = yield* messages;

                while (true) {
                    const nextMessage = yield* subscriptionMessages.next();
                    if (nextMessage.done) {
                        break;
                    }

                    const message = nextMessage.value;
                    if (message.type === "change" || message.type === "refresh") {
                        const subscription = sharedSubscriptions.get(message.subscriptionId);
                        if (!subscription) {
                            continue;
                        }

                        yield* subscription.channel.send(message);
                        continue;
                    }

                    for (const update of message.updates) {
                        const subscription = sharedSubscriptions.get(update.subscriptionId);
                        if (!subscription) {
                            continue;
                        }

                        const stateMessage = { type: "state", status: update.status } as const;
                        yield* subscription.channel.send(stateMessage);

                        if (update.status === "error") {
                            removeDesiredSubscription(desiredSubscriptions, update.subscriptionId);
                        }
                    }
                }
            }));

            function subscribe(objectSet: ObjectSet): Stream<ObjectSetSubscriptionMessage, void> {
                return resource(function* (provideSubscription) {
                    const id = JSON.stringify(objectSet);
                    let subscription = sharedSubscriptions.get(id);
                    if (!subscription) {
                        subscription = {
                            objectSet,
                            channel: createChannel(),
                            consumers: 0,
                        };
                        sharedSubscriptions.set(id, subscription);
                    }

                    subscription.consumers += 1;
                    ensureDesiredSubscription(desiredSubscriptions, id, subscription.objectSet);

                    try {
                        yield* provideSubscription(yield* subscription.channel);
                    } finally {
                        subscription.consumers -= 1;
                        if (subscription.consumers === 0) {
                            sharedSubscriptions.delete(id);
                            removeDesiredSubscription(desiredSubscriptions, id);
                            yield* subscription.channel.close();
                        }
                    }
                });
            }

            yield* provide({ subscribe });
        } finally {
            for (const subscription of sharedSubscriptions.values()) {
                yield* subscription.channel.close();
            }
        }
    });
}
