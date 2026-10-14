import { eq } from "@tanstack/db";
import type { ConnectionManager, ConnectionMonitor } from "./types.js";

const INACTIVE = { status: "inactive" } as const;

export function createConnectionMonitor(manager: ConnectionManager, userId: string): ConnectionMonitor {
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
        reportUnauthenticated: (error) => manager.reportUnauthenticated(userId, error),
    };
}
