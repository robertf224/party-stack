import { Client } from "@osdk/client";
import WebSocket from "isomorphic-ws";
import type {
    ObjectSet,
    ObjectSetStreamSubscribeRequest,
    ObjectSetStreamSubscribeRequests,
    ObjectSetSubscribeResponses,
    ObjectSetUpdates,
    RefreshObjectSet,
    StreamMessage,
    SubscriptionClosed,
} from "@osdk/foundry.ontologies";

// Adapted from (https://github.com/palantir/osdk-ts/blob/main/packages/client/src/objectSet/ObjectSetListenerWebsocket.ts)

const EXPONENTIAL_BACKOFF_INITIAL_DELAY_MS = 1000;
const EXPONENTIAL_BACKOFF_MAX_DELAY_MS = 60000;
const EXPONENTIAL_BACKOFF_MULTIPLIER = 2;
const EXPONENTIAL_BACKOFF_JITTER_FACTOR = 0.3;
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 45 * 1000;

export interface ObjectSetChange {
    type: "added_or_updated" | "removed";
    primaryKey: string;
    object: Record<string, unknown>;
}

export interface ObjectSetWebsocketListener {
    onChange: (change: ObjectSetChange) => void;
    onError?: (error: Error) => void;
    onOutOfDate?: () => void;
    onSuccessfulSubscription?: () => void;
    onReconnecting?: () => void;
}

interface ExponentialBackoff {
    attempt: number;
    calculateDelay: () => number;
    reset: () => void;
}

function createExponentialBackoff(): ExponentialBackoff {
    let attempt = 0;
    return {
        get attempt() {
            return attempt;
        },
        calculateDelay() {
            const delay = Math.min(
                EXPONENTIAL_BACKOFF_INITIAL_DELAY_MS * Math.pow(EXPONENTIAL_BACKOFF_MULTIPLIER, attempt),
                EXPONENTIAL_BACKOFF_MAX_DELAY_MS
            );
            const jitter = delay * EXPONENTIAL_BACKOFF_JITTER_FACTOR * (Math.random() * 2 - 1);
            attempt++;
            return delay + jitter;
        },
        reset() {
            attempt = 0;
        },
    };
}

function constructWebsocketUrl(baseUrl: string, ontologyRid: string): URL {
    const base = new URL(baseUrl);
    const url = new URL(`api/v2/ontologySubscriptions/ontologies/${ontologyRid}/streamSubscriptions`, base);
    url.protocol = url.protocol.replace("https", "wss").replace("http", "ws");
    return url;
}

let requestIdCounter = 0;
function nextRequestId(): string {
    return `00000000-0000-0000-0000-${(requestIdCounter++).toString().padStart(12, "0")}`;
}

export interface ObjectSetWebsocketOpts {
    client: Client;
    ontologyRid: string;
    objectType: string;
    properties?: string[];
    objectSet?: ObjectSet;
    listener: ObjectSetWebsocketListener;
}

type SubscriptionStatus = "preparing" | "subscribed" | "reconnecting" | "closed" | "error";

/**
 * Manages a websocket connection to Foundry for real-time object set updates.
 * Based on the Palantir OSDK ObjectSetListenerWebsocket implementation.
 */
export class ObjectSetWebsocket {
    #ws: WebSocket | undefined;
    #client: Client;
    #ontologyRid: string;
    #properties: string[];
    #objectSet: ObjectSet;
    #listener: ObjectSetWebsocketListener;
    #backoff: ExponentialBackoff;
    #isFirstConnection = true;
    #status: SubscriptionStatus = "preparing";
    #subscriptionId: string | undefined;
    #pendingRequestId: string | undefined;
    #heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    #maybeDisconnectTimeout: ReturnType<typeof setTimeout> | undefined;

    constructor({
        client,
        ontologyRid,
        objectType,
        properties = [],
        objectSet,
        listener,
    }: ObjectSetWebsocketOpts) {
        this.#client = client;
        this.#ontologyRid = ontologyRid;
        this.#properties = properties;
        this.#listener = listener;
        this.#backoff = createExponentialBackoff();

        // If no objectSet provided, create one for all objects of this type
        this.#objectSet = objectSet ?? {
            type: "base",
            objectType: objectType,
        };
    }

    get status(): SubscriptionStatus {
        return this.#status;
    }

    async connect(): Promise<void> {
        await this.#ensureWebsocket();
    }

    close(): void {
        this.#status = "closed";
        this.#cleanupWebsocket();
    }

    async #ensureWebsocket(): Promise<void> {
        if (this.#ws != null) {
            if (this.#ws.readyState === WebSocket.OPEN) {
                return;
            }
            if (this.#ws.readyState === WebSocket.CONNECTING) {
                return this.#waitForConnection();
            }
        }

        // Apply exponential backoff delay on reconnection attempts
        if (!this.#isFirstConnection) {
            const delay = this.#backoff.calculateDelay();
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const url = constructWebsocketUrl(this.#client.__osdkClientContext.baseUrl, this.#ontologyRid);

        // Get auth token - access the client's token provider
        const token = await this.#getToken();

        this.#ws = new WebSocket(url.toString(), [`Bearer-${token}`]);
        this.#ws.addEventListener("close", this.#onClose);
        this.#ws.addEventListener("message", this.#onMessage);
        this.#ws.addEventListener("open", this.#onOpen);
        this.#ws.addEventListener("error", this.#onError);

        return this.#waitForConnection();
    }

    async #getToken(): Promise<string> {
        return this.#client.__osdkClientContext.tokenProvider();
    }

    #waitForConnection(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.#ws) {
                reject(new Error("WebSocket not initialized"));
                return;
            }

            if (this.#ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            const cleanup = () => {
                this.#ws?.removeEventListener("open", onOpen);
                this.#ws?.removeEventListener("error", onError);
                this.#ws?.removeEventListener("close", onClose);
            };

            const onOpen = () => {
                cleanup();
                resolve();
            };

            const onError = (evt: unknown) => {
                cleanup();
                reject(new Error(String(evt)));
            };

            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before connecting"));
            };

            this.#ws.addEventListener("open", onOpen);
            this.#ws.addEventListener("error", onError);
            this.#ws.addEventListener("close", onClose);
        });
    }

    #onOpen = () => {
        this.#isFirstConnection = false;
        this.#backoff.reset();
        this.#sendSubscribeMessage();

        // Start heartbeat to keep connection alive
        if (this.#heartbeatInterval) {
            clearInterval(this.#heartbeatInterval);
        }
        this.#heartbeatInterval = setInterval(() => {
            if (this.#ws?.readyState === WebSocket.OPEN) {
                this.#sendSubscribeMessage();
            }
        }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);
    };

    #onError = (event: WebSocket.ErrorEvent) => {
        const error = new Error(event.message || "WebSocket error");
        this.#listener.onError?.(error);
    };

    #onClose = () => {
        this.#cleanupHeartbeat();

        if (this.#status !== "closed") {
            this.#status = "reconnecting";
            this.#listener.onReconnecting?.();
            void this.#ensureWebsocket();
        }
    };

    #onMessage = (message: WebSocket.MessageEvent) => {
        const messageData = typeof message.data === "string" ? message.data : JSON.stringify(message.data);
        const data = JSON.parse(messageData) as StreamMessage;

        switch (data.type) {
            case "objectSetChanged":
                this.#handleObjectSetChanged(data);
                break;
            case "refreshObjectSet":
                this.#handleRefreshObjectSet(data);
                break;
            case "subscribeResponses":
                this.#handleSubscribeResponses(data);
                break;
            case "subscriptionClosed":
                this.#handleSubscriptionClosed(data);
                break;
            default:
                // Unknown message type
                break;
        }
    };

    #sendSubscribeMessage(): void {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const requestId = nextRequestId();
        this.#pendingRequestId = requestId;

        const request: ObjectSetStreamSubscribeRequests = {
            id: requestId,
            requests: [
                {
                    objectSet: this.#objectSet,
                    propertySet: this.#properties,
                    referenceSet: [],
                } as ObjectSetStreamSubscribeRequest,
            ],
        };

        this.#ws.send(JSON.stringify(request));
    }

    #handleObjectSetChanged(payload: ObjectSetUpdates): void {
        // Only process updates for our subscription
        if (this.#subscriptionId && payload.id !== this.#subscriptionId) {
            return;
        }

        for (const update of payload.updates) {
            if (update.type === "object") {
                const primaryKey = update.object.__primaryKey as string;
                const change: ObjectSetChange = {
                    type: update.state === "REMOVED" ? "removed" : "added_or_updated",
                    primaryKey,
                    object: update.object,
                };
                this.#listener.onChange(change);
            }
        }
    }

    #handleRefreshObjectSet(payload: RefreshObjectSet): void {
        if (this.#subscriptionId && payload.id !== this.#subscriptionId) {
            return;
        }
        this.#listener.onOutOfDate?.();
    }

    #handleSubscribeResponses(payload: ObjectSetSubscribeResponses): void {
        if (payload.id !== this.#pendingRequestId) {
            return;
        }

        this.#pendingRequestId = undefined;

        for (const response of payload.responses) {
            switch (response.type) {
                case "error":
                    this.#status = "error";
                    this.#listener.onError?.(new Error(JSON.stringify(response.errors)));
                    break;
                case "qos":
                    // Server requested we reconnect for load balancing
                    this.#cycleWebsocket();
                    break;
                case "success": {
                    const wasReconnecting = this.#status === "reconnecting";
                    this.#status = "subscribed";
                    this.#subscriptionId = response.id;

                    if (wasReconnecting) {
                        this.#listener.onOutOfDate?.();
                    } else {
                        this.#listener.onSuccessfulSubscription?.();
                    }
                    break;
                }
            }
        }
    }

    #handleSubscriptionClosed(payload: SubscriptionClosed): void {
        if (this.#subscriptionId && payload.id !== this.#subscriptionId) {
            return;
        }

        this.#status = "error";
        this.#listener.onError?.(new Error(`Subscription closed: ${JSON.stringify(payload.cause)}`));
    }

    #cycleWebsocket(): void {
        this.#cleanupWebsocket();

        if (this.#status !== "closed") {
            this.#status = "reconnecting";
            this.#listener.onReconnecting?.();
            void this.#ensureWebsocket();
        }
    }

    #cleanupHeartbeat(): void {
        if (this.#heartbeatInterval) {
            clearInterval(this.#heartbeatInterval);
            this.#heartbeatInterval = undefined;
        }
    }

    #cleanupWebsocket(): void {
        this.#cleanupHeartbeat();

        if (this.#maybeDisconnectTimeout) {
            clearTimeout(this.#maybeDisconnectTimeout);
            this.#maybeDisconnectTimeout = undefined;
        }

        if (this.#ws) {
            this.#ws.removeEventListener("open", this.#onOpen);
            this.#ws.removeEventListener("message", this.#onMessage);
            this.#ws.removeEventListener("close", this.#onClose);
            this.#ws.removeEventListener("error", this.#onError);

            if (this.#ws.readyState !== WebSocket.CLOSING && this.#ws.readyState !== WebSocket.CLOSED) {
                this.#ws.close();
            }
            this.#ws = undefined;
        }
    }
}
