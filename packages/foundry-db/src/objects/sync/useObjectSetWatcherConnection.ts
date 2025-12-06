/* eslint-disable require-yield */
/* eslint-disable react-hooks/rules-of-hooks */
import { invariant } from "@bobbyfidz/panic";
import { Pathnames, Urls } from "@bobbyfidz/urls";
import { useWebSocket } from "@effectionx/websocket";
import { ObjectSetStreamSubscribeRequests, StreamMessage } from "@osdk/foundry.ontologies";
import { resource, spawn, race, sleep, Stream, Operation, createChannel } from "effection";
import { map } from "./effection-utils/stream-helpers";
import { ValueSignal } from "./effection-utils/ValueSignal";
import {
    ObjectSetSubscription,
    ObjectSetSubscriptionMessage,
    ObjectSetSubscriptionStateUpdateMessage,
    ObjectSetSubscriptionStateUpdateMessages,
} from "./ObjectSetSubscription";

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 45 * 1000;

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
 * Creates a resources that tracks the lifetime of a single physical Object Set Watcher connection.
 *
 * Handles connection details, maintaining the connection with heartbeats, and shuttling messages.
 */
export function* useObjectSetWatcherConnection(
    baseUrl: string,
    token: string,
    ontologyRid: string,
    desiredSubscriptions: ValueSignal<ObjectSetSubscription[]>
): Operation<Stream<ObjectSetSubscriptionMessage, CloseEvent>> {
    return yield* resource(function* (provide) {
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
        ): Operation<ObjectSetSubscriptionStateUpdateMessages | undefined> {
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
                        const updates: ObjectSetSubscriptionStateUpdateMessage[] = [];
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

        const subscriptionMessages = createChannel<ObjectSetSubscriptionMessage, CloseEvent>();

        void (yield* spawn(function* () {
            const request = desiredSubscriptions.valueOf();
            const response = yield* sendSubscriptionRequest(request);
            if (response) {
                subscriptionMessages.send(response);
            }

            const desiredSubscriptionsUpdates = yield* desiredSubscriptions;
            while (true) {
                const nextEvent = yield* race([
                    desiredSubscriptionsUpdates.next(),
                    sleep(WEBSOCKET_HEARTBEAT_INTERVAL_MS),
                ]);
                if (nextEvent && nextEvent.done) {
                    break;
                }
                // TODO: figure out if we can heartbeat with a smaller payload.
                const request = nextEvent ? nextEvent.value : desiredSubscriptions.valueOf();
                const response = yield* sendSubscriptionRequest(request);
                if (response) {
                    subscriptionMessages.send(response);
                }
            }
        }));

        void (yield* spawn(function* () {
            const messages = yield* parseMessages(socket);
            while (true) {
                const nextMessage = yield* messages.next();
                if (nextMessage.done) {
                    subscriptionMessages.close(nextMessage.value as CloseEvent);
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
                        subscriptionMessages.send({
                            type: "change",
                            subscriptionId,
                            updates: message.updates,
                        });
                        break;
                    }
                    case "refreshObjectSet": {
                        const subscriptionId = externalSubscriptionIdsToInternal?.get(message.id);
                        invariant(
                            subscriptionId,
                            "Subscription id could not be found, this should never happen."
                        );
                        subscriptionMessages.send({
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
                        subscriptionMessages.send({
                            type: "state",
                            updates: [{ subscriptionId, status: "closed" }],
                        });
                    }
                }
            }
        }));

        yield* provide(subscriptionMessages);
    });
}
