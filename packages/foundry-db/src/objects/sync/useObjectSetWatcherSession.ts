/* eslint-disable react-hooks/rules-of-hooks */
import { createChannel, Operation, resource, sleep, spawn, Stream } from "effection";
import { ValueSignal } from "./effection-utils/ValueSignal";
import { ObjectSetSubscription, ObjectSetSubscriptionMessage } from "./ObjectSetSubscription";
import { useObjectSetWatcherConnection } from "./useObjectSetWatcherConnection";

/**
 * Creates a resources that maintains a logical Object Set Watcher session regardless
 * of blips in network connectivity.
 */
export function* useObjectSetWatcherSession(
    baseUrl: string,
    tokenProvider: () => Operation<string>,
    ontologyRid: string,
    desiredSubscriptions: ValueSignal<ObjectSetSubscription[]>
): Operation<Stream<ObjectSetSubscriptionMessage, void>> {
    return yield* resource(function* (provide) {
        // TODO: turn off connection after a while if there are no object sets we want to subscribe to.

        const subscriptionMessages = createChannel<ObjectSetSubscriptionMessage>();

        void (yield* spawn(function* () {
            while (true) {
                // TODO: yield until we have > 0 queries + auth.

                try {
                    const connection = yield* useObjectSetWatcherConnection(
                        baseUrl,
                        yield* tokenProvider(),
                        ontologyRid,
                        desiredSubscriptions
                    );
                    const messages = yield* connection;
                    while (true) {
                        const nextMessage = yield* messages.next();
                        if (nextMessage.done) {
                            // TODO: capture code here and adjust behavior accordingly.
                            subscriptionMessages.send({
                                type: "state",
                                updates: desiredSubscriptions
                                    .valueOf()
                                    .map(({ id }) => ({ subscriptionId: id, status: "closed" })),
                            });
                            break;
                        }
                        const message = nextMessage.value;

                        if (
                            message.type === "state" &&
                            message.updates.some((update) => update.status === "qos")
                        ) {
                            // TODO: gracefully roll-over to a new connection while we hang onto the old one.
                            subscriptionMessages.send({
                                type: "state",
                                updates: desiredSubscriptions
                                    .valueOf()
                                    .map(({ id }) => ({ subscriptionId: id, status: "qos" })),
                            });
                            break;
                        }

                        subscriptionMessages.send(message);
                    }
                } catch {
                    // TODO: capture error here and adjust behavior accordingly. it seems like browsers
                    // mostly just close rather than erroring, but Node.js might error before closing.
                    subscriptionMessages.send({
                        type: "state",
                        updates: desiredSubscriptions
                            .valueOf()
                            .map(({ id }) => ({ subscriptionId: id, status: "closed" })),
                    });
                }

                // TODO: actual logic here
                // if quit because disconnected from network, yield until we're back online
                // if quit because of qos, yield w/ some jitter
                // if quit because of auth we'll yield at top of loop for new token
                // if quit because 0 queries we'll yield at top of loop for queries
                yield* sleep(5_000);
            }
        }));

        yield* provide(subscriptionMessages);
    });
}
