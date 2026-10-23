import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { makeEncryptionKeyring } from "@party-stack/indexeddb-ontology-storage/encryption-keyring";
import * as IndexedDbTables from "@party-stack/indexeddb-ontology-storage/tables";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { Runtime, RuntimeError } from "@party-stack/runtime";
import { Effect, Layer } from "effect";
import { createActorLiveness } from "./actorLiveness.js";
import { createWebBrowserAuthentication } from "./createWebBrowserAuthentication.js";
import { acquireHost } from "./hostOwnership.js";
import { NavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";
import { OPFSBlobBytesStore } from "./OPFSBlobBytesStore.js";
import type { RuntimeAdapter } from "@party-stack/runtime";

export interface WebRuntimeOptions {
    readonly owner: string;
    readonly namespace: string;
    readonly storage?: "indexeddb" | "memory";
    /** Explicitly allow a non-extractable AES-GCM CryptoKey to persist in IndexedDB across reloads.
     * Same-origin code can still use it to decrypt: this is not a vault lock or protection from XSS.
     * Keys are separate from ordinary table exports. Clearing site data loses the keys and makes
     * remaining local ciphertext unreadable. This flag does not opt encrypted properties into caching;
     * individual decrypt calls must request cache:true. Omitted keys must be composed separately.
     */
    readonly persistEncryptionKeys?: boolean;
}

/** Lazy platform acquisition. The containing Layer Scope owns all open resources. */
export const make = Effect.fn("WebRuntime.make")(function* (options: WebRuntimeOptions) {
    const persistent = options.storage !== "memory";
    if (persistent && !globalThis.navigator?.locks)
        return yield* new RuntimeError({
            operation: "webRuntime.ownership",
            cause: new Error(
                "Web Locks are required for persistent replica ownership. Select isolated memory storage when unavailable."
            ),
        });
    if (
        persistent &&
        (!globalThis.indexedDB || !globalThis.IDBKeyRange || !globalThis.navigator?.storage?.getDirectory)
    )
        return yield* new RuntimeError({
            operation: "webRuntime.storage",
            cause: new Error(
                "IndexedDB and OPFS are unavailable. Isolated memory storage can be selected explicitly."
            ),
        });
    const name = `party-stack:${JSON.stringify([options.owner, options.namespace])}`;
    const connectivity = yield* Effect.acquireRelease(
        Effect.try({
            try: () => NavigatorNetworkConnectivity.create(),
            catch: (cause) => new RuntimeError({ operation: "webRuntime.connectivity", cause }),
        }),
        (value) => Effect.promise(() => value.close())
    );
    const notifications =
        persistent && typeof BroadcastChannel !== "undefined"
            ? yield* Effect.acquireRelease(
                  Effect.try({
                      try: () => new BroadcastChannel(`${name}:storage-events`),
                      catch: (cause) => new RuntimeError({ operation: "webRuntime.notifications", cause }),
                  }),
                  (channel) => Effect.sync(() => channel.close())
              )
            : undefined;
    // Effect's layerWindow reads window; supplying the factory explicitly also works in workers.
    const indexedDb = Layer.sync(IndexedDb.IndexedDb)(() =>
        IndexedDb.make({ indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange })
    );
    const blobBytes = persistent
        ? new OPFSBlobBytesStore({ directoryName: `${name}:blobs` })
        : new MemoryBlobBytesStore();
    const adapter: RuntimeAdapter = {
        acquireHost: persistent ? acquireHost(name) : undefined,
        owner: options.owner,
        namespace: options.namespace,

        connectivity,
        blobBytes,
        tables: persistent
            ? IndexedDbTables.make({ databaseName: `${name}:storage` }).pipe(Effect.provide(indexedDb))
            : undefined,
        destroy: persistent
            ? async () => {
                  await Promise.all([
                      deleteDatabase(name),
                      deleteDatabase(`${name}:storage`),
                      deleteDatabase(`${name}:keys`),
                      blobBytes instanceof OPFSBlobBytesStore ? blobBytes.clear() : Promise.resolve(),
                  ]);
              }
            : undefined,
        encryptionKeyring:
            persistent && options.persistEncryptionKeys
                ? makeEncryptionKeyring(`${name}:keys`).pipe(Effect.provide(indexedDb))
                : undefined,
        browserAuthentication: typeof window !== "undefined" ? createWebBrowserAuthentication() : undefined,
        actorLiveness: persistent && globalThis.navigator?.locks ? createActorLiveness(name) : undefined,
        storageNotifications: notifications
            ? {
                  publish: () => notifications.postMessage(null),
                  subscribe: (listener) => {
                      notifications.addEventListener("message", listener);
                      const visible = () => {
                          if (document.visibilityState === "visible") listener();
                      };
                      if (typeof document !== "undefined") {
                          document.addEventListener("visibilitychange", visible);
                          globalThis.addEventListener("pageshow", listener);
                          globalThis.addEventListener("focus", listener);
                      }
                      return () => {
                          notifications.removeEventListener("message", listener);
                          if (typeof document !== "undefined") {
                              document.removeEventListener("visibilitychange", visible);
                              globalThis.removeEventListener("pageshow", listener);
                              globalThis.removeEventListener("focus", listener);
                          }
                      };
                  },
              }
            : undefined,
    };
    return yield* Runtime.make(adapter);
});

export const layer = (options: WebRuntimeOptions) => Layer.effect(Runtime, make(options));

function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(new Error(`IndexedDB database "${name}" could not be deleted.`, { cause: request.error }));
        request.onblocked = () => reject(new Error(`IndexedDB database "${name}" is still open.`));
    });
}
