import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { makeEncryptionKeyring } from "@party-stack/indexeddb-ontology-storage/encryption-keyring";
import * as IndexedDbTables from "@party-stack/indexeddb-ontology-storage/tables";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeMemoryEncryptionKeyring, MemoryBlobBytesStore } from "@party-stack/runtime";
import { Runtime, RuntimeError, RuntimePartition } from "@party-stack/runtime";
import { Effect, Layer } from "effect";
import { createWebBrowserAuthentication } from "./createWebBrowserAuthentication.js";
import { makeNavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";
import { OPFSBlobBytesStore } from "./OPFSBlobBytesStore.js";
import type { RuntimeOptions } from "@party-stack/runtime";

export interface WebRuntimeOptions {
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
export const make = Effect.fn("WebRuntime.make")(function* (options: WebRuntimeOptions = {}) {
    const { owner, namespace } = yield* RuntimePartition;
    const persistent = options.storage !== "memory";
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
    const name = `party-stack:${JSON.stringify([owner, namespace])}`;
    const connectivity = yield* makeNavigatorNetworkConnectivity();
    // Effect's layerWindow reads window; supplying the factory explicitly also works in workers.
    const indexedDb = Layer.sync(IndexedDb.IndexedDb)(() =>
        IndexedDb.make({ indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange })
    );
    const blobBytes = persistent
        ? new OPFSBlobBytesStore({ directoryName: `${name}:blobs` })
        : new MemoryBlobBytesStore();
    const adapter: RuntimeOptions = {
        connectivity,
        blobBytes,
        tables: persistent
            ? yield* IndexedDbTables.make({ databaseName: `${name}:storage` }).pipe(Effect.provide(indexedDb))
            : yield* Memory.make(),
        destroy: persistent
            ? Effect.tryPromise({
                  try: async () => {
                      await Promise.all([
                          deleteDatabase(name),
                          deleteDatabase(`${name}:storage`),
                          deleteDatabase(`${name}:keys`),
                          blobBytes instanceof OPFSBlobBytesStore
                              ? Effect.runPromise(blobBytes.clear())
                              : Promise.resolve(),
                      ]);
                  },
                  catch: (cause) => new RuntimeError({ operation: "destroy", cause }),
              })
            : undefined,
        encryptionKeyring:
            persistent && options.persistEncryptionKeys
                ? yield* makeEncryptionKeyring(`${name}:keys`).pipe(Effect.provide(indexedDb))
                : persistent
                  ? undefined
                  : yield* makeMemoryEncryptionKeyring(),
        browserAuthentication: typeof window !== "undefined" ? createWebBrowserAuthentication() : undefined,
    };
    return yield* Runtime.make(adapter);
});

export const layer = (options: WebRuntimeOptions = {}) => Layer.effect(Runtime, make(options));

function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(new Error(`IndexedDB database "${name}" could not be deleted.`, { cause: request.error }));
        request.onblocked = () => reject(new Error(`IndexedDB database "${name}" is still open.`));
    });
}
