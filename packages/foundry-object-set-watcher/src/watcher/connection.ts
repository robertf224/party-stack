import { createFoundryWebSocket } from "@party-stack/foundry-client";
import { Cause, Clock, Effect, Queue, Schema } from "effect";
import { bigIntToUuid, convertSubscriptionMessage, serializeRequest } from "../protocol.js";
import { WatcherError } from "./model.js";
import type { ObjectSetSubscription, ObjectSetSubscriptionsMessage } from "../types.js";
import type { StreamMessage } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

export interface WatcherConnectionOptions {
    readonly client: OntologyClient;
    readonly changes: Queue.Queue<void>;
    readonly desired: () => ObjectSetSubscription[];
    readonly publish: (message: ObjectSetSubscriptionsMessage) => Effect.Effect<void>;
    readonly heartbeatMs: number;
    readonly responseTimeoutMs: number;
}

const ResponseSchema = Schema.Union([
    Schema.Struct({ type: Schema.Literal("success"), id: Schema.String }),
    Schema.Struct({ type: Schema.Literal("qos") }),
    Schema.Struct({ type: Schema.Literal("error") }),
]);
const MessageSchema = Schema.Union([
    Schema.Struct({
        type: Schema.Literal("subscribeResponses"),
        id: Schema.String,
        responses: Schema.Array(ResponseSchema),
    }),
    Schema.Struct({
        type: Schema.Literal("objectSetChanged"),
        id: Schema.String,
        updates: Schema.Array(
            Schema.Union([
                Schema.Struct({
                    type: Schema.Literal("object"),
                    state: Schema.Literals(["ADDED_OR_UPDATED", "REMOVED"]),
                    object: Schema.StructWithRest(
                        Schema.Struct({
                            __primaryKey: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
                        }),
                        [Schema.Record(Schema.String, Schema.Unknown)]
                    ),
                }),
                Schema.Struct({
                    type: Schema.Literal("reference"),
                    objectType: Schema.String,
                    primaryKey: Schema.Record(Schema.String, Schema.Unknown),
                    property: Schema.String,
                    value: Schema.Unknown,
                }),
            ])
        ),
    }),
    Schema.Struct({ type: Schema.Literal("refreshObjectSet"), id: Schema.String, objectType: Schema.String }),
    Schema.Struct({ type: Schema.Literal("subscriptionClosed"), id: Schema.String }),
]);
type Frame = { type: "open" | "close" | "error" | "desired" | "tick" } | { type: "message"; data: unknown };
const safelyClose = (socket: WebSocket) => {
    try {
        socket.close();
    } catch {
        /* A failed/closing socket already has no usable session. */
    }
};
const openSocket = (create: () => Promise<WebSocket>) =>
    Effect.callback<WebSocket, WatcherError>((resume) => {
        let cancelled = false;
        void Promise.resolve()
            .then(create)
            .then(
                (socket) => {
                    if (cancelled) safelyClose(socket);
                    else resume(Effect.succeed(socket));
                },
                (cause) => {
                    if (!cancelled) resume(Effect.fail(new WatcherError({ reason: "Open", cause })));
                }
            );
        return Effect.sync(() => {
            cancelled = true;
        });
    });

export const runWatcherConnection = Effect.fn("ObjectSetWatcher.connection")(function* (
    options: WatcherConnectionOptions
) {
    const { client, changes, desired, publish, heartbeatMs: heartbeat, responseTimeoutMs: timeout } = options;
    const create = client.createWebSocket ?? createFoundryWebSocket(client);
    const url = new URL(
        `/api/v2/ontologySubscriptions/ontologies/${encodeURIComponent(client.ontologyRid)}/streamSubscriptions`,
        client.baseUrl
    );
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const socket = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
            const socket = yield* restore(openSocket(() => create(url.toString())));
            yield* Effect.addFinalizer(() => Effect.sync(() => safelyClose(socket)));
            return socket;
        })
    );
    const frames = yield* Queue.bounded<Frame, WatcherError>(256);
    const put = (frame: Frame) => {
        if (!Queue.offerUnsafe(frames, frame))
            Queue.failCauseUnsafe(frames, Cause.fail(new WatcherError({ reason: "Overflow" })));
    };
    const message = (event: MessageEvent) => put({ type: "message", data: event.data });
    const opened = () => put({ type: "open" });
    const ended = () => put({ type: "close" });
    const error = () => put({ type: "error" });
    yield* Effect.acquireRelease(
        Effect.sync(() => {
            socket.addEventListener("message", message);
            socket.addEventListener("open", opened);
            socket.addEventListener("close", ended);
            socket.addEventListener("error", error);
        }),
        () =>
            Effect.sync(() => {
                socket.removeEventListener("message", message);
                socket.removeEventListener("open", opened);
                socket.removeEventListener("close", ended);
                socket.removeEventListener("error", error);
                Queue.shutdownUnsafe(frames);
            })
    );
    yield* Effect.forkScoped(
        Effect.forever(
            Effect.gen(function* () {
                yield* Queue.take(changes);
                yield* Queue.offer(frames, { type: "desired" });
            })
        )
    );
    yield* Effect.forkScoped(
        Effect.forever(
            Effect.gen(function* () {
                yield* Effect.sleep(Math.min(1000, heartbeat, timeout));
                yield* Queue.offer(frames, { type: "tick" });
            })
        )
    );
    let requestId = 0n;
    let pending: { id: string; requests: ObjectSetSubscription[]; sent: number } | undefined;
    let lastSent = 0;
    let dirty = false;
    let isOpen = socket.readyState === 1;
    let mapping = new Map<string, string>();
    const send = Effect.fnUntraced(function* () {
        if (!isOpen || pending) {
            dirty = true;
            return;
        }
        const requests = desired();
        if (!requests.length) return yield* new WatcherError({ reason: "Closed" });
        const id = ++requestId;
        lastSent = yield* Clock.currentTimeMillis;
        pending = { id: bigIntToUuid(id), requests, sent: lastSent };
        dirty = false;
        yield* Effect.try({
            try: () => socket.send(serializeRequest(id, requests)),
            catch: (cause) => new WatcherError({ reason: "Closed", cause }),
        });
    });
    if (isOpen) yield* send();
    for (;;) {
        const frame = yield* Queue.take(frames);
        if (frame.type === "close" || frame.type === "error")
            return yield* new WatcherError({ reason: "Closed" });
        if (frame.type === "open") {
            isOpen = true;
            yield* send();
            continue;
        }
        if (frame.type === "desired") {
            yield* send();
            continue;
        }
        if (frame.type === "tick") {
            const now = yield* Clock.currentTimeMillis;
            if (pending && now - pending.sent >= timeout)
                return yield* new WatcherError({ reason: "Timeout" });
            if (!pending && now - lastSent >= heartbeat) yield* send();
            continue;
        }
        if (frame.type !== "message") continue;
        const message = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(MessageSchema)(JSON.parse(String(frame.data))),
            catch: (cause) => new WatcherError({ reason: "Protocol", cause }),
        });
        if (message.type === "subscribeResponses") {
            if (!pending || message.id !== pending.id) continue;
            if (message.responses.length !== pending.requests.length)
                return yield* new WatcherError({ reason: "Protocol" });
            const next = new Map<string, string>();
            let qos = false;
            for (const [index, response] of message.responses.entries()) {
                const target = pending.requests[index]!.id;
                if (response.type === "success") next.set(response.id, target);
                else if (response.type === "qos") qos = true;
                yield* publish({
                    type: "state",
                    updates: [
                        {
                            subscriptionId: target,
                            status: response.type === "success" ? "open" : response.type,
                        },
                    ],
                });
            }
            mapping = next;
            pending = undefined;
            if (qos) return yield* new WatcherError({ reason: "QoS" });
            if (dirty) yield* send();
        } else {
            const update = convertSubscriptionMessage(message as StreamMessage, mapping);
            if (!update) continue;
            yield* publish(update);
        }
    }
});
