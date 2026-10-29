import { Effect, Stream, Queue } from "effect";
import type { ConnectionManagerService, ConnectionMonitor, ConnectionState } from "./types.js";

const INACTIVE = { status: "inactive" } as const;

export function createConnectionMonitor(
    manager: Pick<ConnectionManagerService, "connections" | "subscribeConnection" | "reportUnauthenticated">,
    userId: string
): ConnectionMonitor {
    const getState = () => manager.connections.get(userId)?.state ?? INACTIVE;
    return {
        get state() {
            return getState();
        },
        subscribe: (listener) => manager.subscribeConnection(userId, listener),
        changes: Stream.callback<ConnectionState>(
            (queue) =>
                Effect.acquireRelease(
                    Effect.sync(() => {
                        Queue.offerUnsafe(queue, getState());
                        return manager.subscribeConnection(userId, (state) =>
                            Queue.offerUnsafe(queue, state)
                        );
                    }),
                    (unsubscribe) => Effect.sync(unsubscribe)
                ),
            { bufferSize: 1, strategy: "sliding" }
        ),
        reportUnauthenticated: (error) => manager.reportUnauthenticated(userId, error),
    };
}
