import { Context, Effect, Fiber, Layer, PubSub, Queue, Semaphore, Stream } from "effect";
import { runWatcherConnection } from "./watcher/connection.js";
import { WatcherError } from "./watcher/model.js";
import { runWatcherSession } from "./watcher/session.js";
import type { WatcherOptions } from "./watcher/model.js";
export { WatcherError } from "./watcher/model.js";
export type { WatcherOptions } from "./watcher/model.js";
import type {
    ObjectSetSubscription,
    ObjectSetSubscriptionMessage,
    ObjectSetSubscriptionsMessage,
} from "./types.js";
import type { ObjectSet } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

export interface ObjectSetWatcherService {
    subscribe(objectSet: ObjectSet): Stream.Stream<ObjectSetSubscriptionMessage, WatcherError>;
}
export class ObjectSetWatcher extends Context.Service<ObjectSetWatcher, ObjectSetWatcherService>()(
    "@party-stack/foundry-object-set-watcher/ObjectSetWatcher"
) {
    static readonly layer = (client: OntologyClient, options?: WatcherOptions) =>
        Layer.effect(ObjectSetWatcher, makeObjectSetWatcher(client, options));
}
interface Shared {
    readonly id: string;
    readonly objectSet: ObjectSet;
    readonly events: PubSub.PubSub<ObjectSetSubscriptionMessage>;
    consumers: number;
    disabled: boolean;
    state?: Extract<ObjectSetSubscriptionMessage, { type: "state" }>;
}
const canonical = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([key, item]) => [key, canonical(item)])
            )
          : value;
/** Socket sessions exist only while consumers exist. Every socket, timer and consumer is scoped. */
export const makeObjectSetWatcher = Effect.fn("ObjectSetWatcher.make")(function* (
    client: OntologyClient,
    options: WatcherOptions = {}
) {
    const heartbeat = options.heartbeatMs ?? 45000;
    const timeout = options.responseTimeoutMs ?? 30000;
    const retry = options.retryDelayMs ?? 5000;
    if (![heartbeat, timeout, retry].every((value) => Number.isFinite(value) && value > 0))
        return yield* new WatcherError({ reason: "Protocol" });
    const scope = yield* Effect.scope;
    const changes = yield* Queue.sliding<void>(1);
    const gate = yield* Semaphore.make(1);
    const shared = new Map<string, Shared>();
    let session: Fiber.Fiber<void, never> | undefined;
    let closed = false;
    yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
            closed = true;
            for (const entry of shared.values()) yield* PubSub.shutdown(entry.events);
            yield* Queue.shutdown(changes);
        })
    );
    const desired = (): ObjectSetSubscription[] =>
        [...shared.values()]
            .filter((entry) => !entry.disabled)
            .map((entry) => ({
                id: entry.id,
                objectSet: entry.objectSet,
                propertySet: [],
                referenceSet: [],
            }));
    const publishState = (status: "open" | "closed" | "qos" | "error") =>
        Effect.forEach(
            [...shared.values()],
            (entry) =>
                Effect.suspend(() => {
                    entry.state = { type: "state", status };
                    return PubSub.publish(entry.events, entry.state);
                }),
            { discard: true }
        );
    const publish = Effect.fnUntraced(function* (message: ObjectSetSubscriptionsMessage) {
        if (message.type === "state") {
            for (const update of message.updates) {
                const target = shared.get(update.subscriptionId);
                if (!target) continue;
                if (update.status === "error") target.disabled = true;
                target.state = { type: "state", status: update.status };
                yield* PubSub.publish(target.events, target.state);
            }
        } else {
            const target = shared.get(message.subscriptionId);
            if (target)
                yield* PubSub.publish(
                    target.events,
                    message.type === "change"
                        ? { type: "change", updates: message.updates }
                        : { type: "refresh", objectType: message.objectType }
                );
        }
    });
    const logical = runWatcherSession({
        hasDemand: () => desired().length > 0,
        changes,
        connect: () =>
            runWatcherConnection({
                client,
                changes,
                desired,
                publish,
                heartbeatMs: heartbeat,
                responseTimeoutMs: timeout,
            }),
        disconnected: publishState("closed"),
        retryDelayMs: retry,
    });
    const service: ObjectSetWatcherService = {
        subscribe: (objectSet) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    if (closed) return yield* new WatcherError({ reason: "Closed" });
                    const key = JSON.stringify(canonical(objectSet));
                    let changed = false;
                    const entry = yield* Effect.acquireRelease(
                        gate.withPermits(1)(
                            Effect.gen(function* () {
                                let entry = shared.get(key);
                                if (!entry) {
                                    changed = true;
                                    entry = {
                                        id: key,
                                        objectSet,
                                        consumers: 0,
                                        disabled: false,
                                        events: yield* PubSub.bounded<ObjectSetSubscriptionMessage>(256),
                                    };
                                    shared.set(key, entry);
                                }
                                entry.consumers++;
                                if (entry.disabled) changed = true;
                                entry.disabled = false;
                                return entry;
                            })
                        ),
                        (entry) =>
                            gate.withPermits(1)(
                                Effect.gen(function* () {
                                    entry.consumers--;
                                    if (!entry.consumers) {
                                        shared.delete(key);
                                        yield* PubSub.shutdown(entry.events);
                                        yield* Queue.offer(changes, undefined);
                                    }
                                    if (!shared.size && session) {
                                        const stopped = session;
                                        session = undefined;
                                        yield* Fiber.interrupt(stopped);
                                    }
                                })
                            )
                    );
                    const messages = yield* PubSub.subscribe(entry.events);
                    yield* gate.withPermits(1)(
                        Effect.gen(function* () {
                            if (!session) session = yield* Effect.forkIn(logical, scope);
                        })
                    );
                    if (changed) yield* Queue.offer(changes, undefined);
                    const live = Stream.fromEffectRepeat(PubSub.take(messages));
                    return entry.state ? Stream.concat(Stream.make(entry.state), live) : live;
                })
            ),
    };
    return service;
});
