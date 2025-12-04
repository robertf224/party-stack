/* eslint-disable require-yield */
/* eslint-disable react-hooks/rules-of-hooks */
import { Pathnames, Urls } from "@bobbyfidz/urls";
import { useWebSocket } from "@effectionx/websocket";
import { ObjectSetStreamSubscribeRequests, StreamMessage } from "@osdk/foundry.ontologies";
import { resource, spawn, race, sleep, Subscription, Stream, Operation } from "effection";
import { filter, map } from "./stream-helpers";

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 45 * 1000;
const DEFAULT_SUBSCRIPTION_REQUEST: ObjectSetStreamSubscribeRequests = {
    id: crypto.randomUUID(),
    requests: [],
};

/**
 * Creates a resources that tracks the lifetime of a single Object Set Watcher connection.
 *
 * Handles connection details, maintaining the connection with heartbeats, and shuttling messages.
 * Retries and reconnections are left to callers.
 */
export function* useObjectSetWatcherConnection(
    baseUrl: string,
    token: string,
    ontologyRid: string,
    requests: Subscription<ObjectSetStreamSubscribeRequests, never>
    // TODO: abstract over WebSocket CloseEvent
): Operation<Stream<StreamMessage, CloseEvent>> {
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

        void (yield* spawn(function* () {
            let lastRequest: ObjectSetStreamSubscribeRequests | undefined;
            while (true) {
                const nextEvent = yield* race([requests.next(), sleep(WEBSOCKET_HEARTBEAT_INTERVAL_MS)]);
                let nextRequest: ObjectSetStreamSubscribeRequests;
                if (nextEvent) {
                    nextRequest = nextEvent.value;
                } else {
                    nextRequest = lastRequest ?? DEFAULT_SUBSCRIPTION_REQUEST;
                }
                socket.send(JSON.stringify(nextRequest));
                lastRequest = nextRequest;
            }
        }));

        const parseResponses = map<MessageEvent, StreamMessage>(function* (message) {
            return JSON.parse(String(message.data)) as StreamMessage;
        });
        const filterResponses = filter<StreamMessage>(function* (message) {
            return message.id !== DEFAULT_SUBSCRIPTION_REQUEST.id;
        });

        yield* provide(filterResponses(parseResponses(socket)));
    });
}
