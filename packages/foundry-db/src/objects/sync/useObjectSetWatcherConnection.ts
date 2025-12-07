/* eslint-disable require-yield */
/* eslint-disable react-hooks/rules-of-hooks */
import { invariant } from "@bobbyfidz/panic";
import { Pathnames, Urls } from "@bobbyfidz/urls";
import { useWebSocket } from "@effectionx/websocket";
import { ObjectSetStreamSubscribeRequests, ObjectSetUpdate, StreamMessage } from "@osdk/foundry.ontologies";
import { resource, spawn, race, sleep, Stream, Operation, createChannel, ensure } from "effection";
import { map } from "./effection-utils/stream-helpers";
import { ValueSignal } from "./effection-utils/ValueSignal";
import {
    ObjectSetSubscription,
    ObjectSetSubscriptionsMessage,
    ObjectSetSubscriptionsStateUpdateMessage,
    ObjectSetSubscriptionsStateUpdateMessages,
} from "./ObjectSetSubscription";

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 45_000;

function bigIntToUuid(value: bigint): string {
    const decimalString = value.toString().padStart(32, "0");
    return `${decimalString.substring(0, 8)}-${decimalString.substring(8, 12)}-${decimalString.substring(12, 16)}-${decimalString.substring(16, 20)}-${decimalString.substring(20)}`;
}

function uuidToBigInt(uuid: string): bigint {
    const decimalString = uuid.replace(/-/g, "");
    return BigInt(decimalString);
}

function serializeRequest(requestId: bigint, request: ObjectSetSubscription[]): string {
    return JSON.stringify({
        id: bigIntToUuid(requestId),
        // Strip out our internal subscription ids.
        requests: request.map(({ objectSet, propertySet, referenceSet }) => ({
            objectSet,
            propertySet,
            referenceSet,
        })),
    } satisfies ObjectSetStreamSubscribeRequests);
}

const parseMessages = map<MessageEvent, StreamMessage>(function* (message) {
    return JSON.parse(String(message.data)) as StreamMessage;
});

/**
 * We sometimes see duplicate primary keys in a single message (it seems like when there are multiple updates to the same object in a short period of time)
 * which causes problems downstream, so we clean that up here.
 */
function filterChangeMessages(updates: ObjectSetUpdate[]): ObjectSetUpdate[] {
    const reversedUpdates = [...updates].reverse();
    const seen = new Set<string | number>();
    const filteredUpdates: ObjectSetUpdate[] = [];
    for (const update of reversedUpdates) {
        switch (update.type) {
            case "object": {
                const primaryKey = (update.object as unknown as { __primaryKey: string | number })
                    .__primaryKey;
                if (!seen.has(primaryKey)) {
                    filteredUpdates.push(update);
                    seen.add(primaryKey);
                }
                break;
            }
            case "reference": {
                filteredUpdates.push(update);
                break;
            }
        }
    }
    return filteredUpdates;
}

/**
 * Creates a resources that tracks the lifetime of a single physical Object Set Watcher connection.
 *
 * Handles connection details, maintaining the connection with heartbeats, and shuttling messages.
 */
export function useObjectSetWatcherConnection(
    baseUrl: string,
    token: string,
    ontologyRid: string,
    desiredSubscriptions: ValueSignal<ObjectSetSubscription[]>
): Operation<Stream<ObjectSetSubscriptionsMessage, CloseEvent | void>> {
    return resource(function* (provide) {
        const subscriptionMessages = createChannel<ObjectSetSubscriptionsMessage, CloseEvent | void>();

        const socket = yield* useWebSocket(
            Urls.extend(baseUrl, {
                protocol: "wss:",
                pathname: Pathnames.join(
                    "/api/v2/ontologySubscriptions/ontologies",
                    ontologyRid,
                    "streamSubscriptions"
                ),
            }).toString(),
            `Bearer-${token}`
        );

        let latestRequestId = 0n;
        let externalSubscriptionIdsToInternal: Map<string, string> | undefined;
        function* sendSubscriptionRequest(
            request: ObjectSetSubscription[]
        ): Operation<ObjectSetSubscriptionsStateUpdateMessages | undefined> {
            const requestId = latestRequestId + 1n;
            latestRequestId = requestId;
            // Open a subscription before sending our request to make sure we don't miss it on the way back.
            const messages = yield* parseMessages(socket);
            socket.send(serializeRequest(requestId, request));
            while (true) {
                const nextMessage = yield* messages.next();
                if (nextMessage.done) {
                    break;
                }
                const message = nextMessage.value;
                if (message.type === "subscribeResponses") {
                    const messageRequestId = uuidToBigInt(message.id);
                    if (messageRequestId > requestId) {
                        // A newer message than ours arrived which will have the latest state, so we can stop waiting.
                        break;
                    }
                    if (messageRequestId === requestId) {
                        externalSubscriptionIdsToInternal = new Map();
                        const updates: ObjectSetSubscriptionsStateUpdateMessage[] = [];
                        for (let i = 0; i < message.responses.length; i++) {
                            const subscriptionRequest = request[i]!;
                            const subscriptionResponse = message.responses[i]!;
                            switch (subscriptionResponse.type) {
                                case "success": {
                                    externalSubscriptionIdsToInternal.set(
                                        subscriptionResponse.id,
                                        subscriptionRequest.id
                                    );
                                    updates.push({ subscriptionId: subscriptionRequest.id, status: "open" });
                                    break;
                                }
                                case "qos": {
                                    updates.push({ subscriptionId: subscriptionRequest.id, status: "qos" });
                                    break;
                                }
                                case "error": {
                                    updates.push({ subscriptionId: subscriptionRequest.id, status: "error" });
                                    break;
                                }
                            }
                        }
                        return { type: "state", updates };
                    }
                }
            }
        }

        void (yield* spawn(function* () {
            const request = desiredSubscriptions.valueOf();
            const response = yield* sendSubscriptionRequest(request);
            if (response) {
                yield* subscriptionMessages.send(response);
            }

            const desiredSubscriptionsUpdates = yield* desiredSubscriptions;
            while (true) {
                console.log("Racing heartbeat and next subscription update...");
                const nextEvent = yield* race([
                    desiredSubscriptionsUpdates.next(),
                    sleep(WEBSOCKET_HEARTBEAT_INTERVAL_MS),
                ]);
                if (nextEvent && nextEvent.done) {
                    console.log("Subscription updates closed in connection.");
                    break;
                }
                // TODO: figure out if we can heartbeat with a smaller payload.
                const request = nextEvent ? nextEvent.value : desiredSubscriptions.valueOf();
                const response = yield* sendSubscriptionRequest(request);
                if (response) {
                    yield* subscriptionMessages.send(response);
                }
            }
        }));

        void (yield* spawn(function* () {
            const messages = yield* parseMessages(socket);
            while (true) {
                const nextMessage = yield* messages.next();
                if (nextMessage.done) {
                    yield* subscriptionMessages.close(nextMessage.value as CloseEvent);
                    break;
                }
                const message = nextMessage.value;
                switch (message.type) {
                    case "objectSetChanged": {
                        const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
                        invariant(
                            subscriptionId,
                            "Subscription id could not be found, this should never happen."
                        );
                        yield* subscriptionMessages.send({
                            type: "change",
                            subscriptionId,
                            updates: filterChangeMessages(message.updates),
                        });
                        break;
                    }
                    case "refreshObjectSet": {
                        const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
                        invariant(
                            subscriptionId,
                            "Subscription id could not be found, this should never happen."
                        );
                        yield* subscriptionMessages.send({
                            type: "refresh",
                            subscriptionId,
                            objectType: message.objectType,
                        });
                        break;
                    }
                    case "subscriptionClosed": {
                        const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
                        invariant(
                            subscriptionId,
                            "Subscription id could not be found, this should never happen."
                        );
                        yield* subscriptionMessages.send({
                            type: "state",
                            updates: [{ subscriptionId, status: "closed" }],
                        });
                    }
                }
            }
        }));

        yield* ensure(function* () {
            console.log("Cleaning up connection...");
            yield* subscriptionMessages.close();
        });
        yield* provide(subscriptionMessages);
    });
}
