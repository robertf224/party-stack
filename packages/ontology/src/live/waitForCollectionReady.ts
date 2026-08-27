import type { Collection } from "@tanstack/db";

/**
 * Starts idle/on-demand collection synchronization and waits until the
 * collection is ready.
 *
 * TanStack's `onFirstReady` only registers a callback: it does not start an
 * idle collection, report terminal errors, or distinguish cleanup from
 * readiness. Pending callbacks are also invoked during cleanup. This helper
 * starts sync, returns an awaitable promise, and rejects on error or cleanup.
 *
 * Race-safe: status listeners are registered before starting sync / reading
 * the current status, so a transition cannot be missed.
 */
async function waitForCollectionReady(
    collection: Collection<Record<string, unknown>, string | number>
): Promise<void> {
    if (collection.status === "ready") return;
    if (collection.status === "error") {
        throw new Error(`Collection "${collection.id}" is in an error state.`);
    }
    if (collection.status === "cleaned-up") {
        throw new Error(`Collection "${collection.id}" has been cleaned up.`);
    }

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            off();
            if (error) reject(error);
            else resolve();
        };

        const off = collection.on("status:change", (event) => {
            if (event.status === "ready") {
                finish();
            } else if (event.status === "error") {
                finish(new Error(`Collection "${collection.id}" is in an error state.`));
            } else if (event.status === "cleaned-up") {
                finish(new Error(`Collection "${collection.id}" has been cleaned up.`));
            }
        });

        // Start sync after the listener is attached so we cannot miss ready.
        if (collection.status === "idle") {
            try {
                collection.startSyncImmediate();
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
                return;
            }
        }

        // Close the TOCTOU window for a status that was already terminal.
        if (collection.status === "ready") {
            finish();
        } else if (collection.status === "error") {
            finish(new Error(`Collection "${collection.id}" is in an error state.`));
        } else if (collection.status === "cleaned-up") {
            finish(new Error(`Collection "${collection.id}" has been cleaned up.`));
        }
    });
}

export async function waitForCollectionsReady(
    collections: Iterable<Collection<Record<string, unknown>, string | number>>
): Promise<void> {
    await Promise.all([...collections].map((collection) => waitForCollectionReady(collection)));
}
