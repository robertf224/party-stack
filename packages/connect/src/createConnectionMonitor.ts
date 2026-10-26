import { eq } from "@tanstack/db";
import { Effect, Stream, Queue } from "effect";
import type { ConnectionManagerService, ConnectionMonitor, ConnectionState } from "./types.js";

const INACTIVE = { status: "inactive" } as const;

export function createConnectionMonitor(
    manager: Pick<ConnectionManagerService, "connections" | "reportUnauthenticated">,
    userId: string
): ConnectionMonitor {
    const getState = () => manager.connections.get(userId)?.state ?? INACTIVE;
    return {
        get state() {
            return getState();
        },
        subscribe(listener) {
            const subscription = manager.connections.subscribeChanges(
                () => {
                    listener(getState());
                },
                {
                    where: (connection) => eq(connection.userId, userId),
                }
            );
            return () => subscription.unsubscribe();
        },
        changes: Stream.callback<ConnectionState>((queue) =>
            Effect.acquireRelease(
                Effect.sync(() => {
                    Queue.offerUnsafe(queue, getState());
                    return manager.connections.subscribeChanges(() => Queue.offerUnsafe(queue, getState()), {
                        where: (connection) => eq(connection.userId, userId),
                    });
                }),
                (subscription) => Effect.sync(() => subscription.unsubscribe())
            )
        ),
        reportUnauthenticated: (error) => manager.reportUnauthenticated(userId, error),
    };
}
