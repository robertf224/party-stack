import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { makeEncryptionKeyring } from "@party-stack/indexeddb-ontology-storage/encryption-keyring";
import * as IndexedDbTables from "@party-stack/indexeddb-ontology-storage/tables";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { makeMemoryEncryptionKeyring, MemoryBlobBytesStore } from "@party-stack/runtime";
import { Runtime, RuntimeError, RuntimePartition, Runtimes } from "@party-stack/runtime";
import { Effect, Layer } from "effect";
import { createWebBrowserAuthentication } from "./createWebBrowserAuthentication.js";
import { makeNavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";
import { OPFSBlobBytesStore } from "./OPFSBlobBytesStore.js";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { RuntimeOptions, RuntimeAcquisitionError } from "@party-stack/runtime";
import type { Scope } from "effect";

export interface WebRuntimeOptions {
    /** Selects the built-in tables and ancillary blob/keyring/capacity persistence. */
    readonly storage?: "indexeddb" | "memory";
    /** Replace table acquisition without changing browser capabilities or opening built-in tables.
     * The acquisition Scope owns open resources. Destroy must also work after that Scope closes;
     * it deletes this partition's custom tables when the replica is forgotten.
     */
    readonly tables?: Effect.Effect<
        { readonly tables: TablesService; readonly destroy: Effect.Effect<void, RuntimeAcquisitionError> },
        RuntimeAcquisitionError,
        RuntimePartition | Scope.Scope
    >;
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
    const customTables = options.tables ? yield* options.tables : undefined;
    const adapter: RuntimeOptions = {
        capacity: {
            memory: Effect.succeed(undefined),
            storage: persistent
                ? Effect.tryPromise({
                      try: async () => {
                          if (!globalThis.navigator?.storage?.estimate) return undefined;
                          const estimate = await navigator.storage.estimate();
                          return {
                              scope: "origin" as const,
                              usedBytes: estimate.usage,
                              limitBytes: estimate.quota,
                              availableBytes:
                                  estimate.quota === undefined || estimate.usage === undefined
                                      ? undefined
                                      : Math.max(0, estimate.quota - estimate.usage),
                          };
                      },
                      catch: (cause) => new RuntimeError({ operation: "capacity.storage", cause }),
                  })
                : Effect.succeed(undefined),
        },
        connectivity,
        blobBytes,
        tables:
            customTables?.tables ??
            (persistent
                ? yield* IndexedDbTables.make({ databaseName: `${name}:storage` }).pipe(
                      Effect.provide(indexedDb)
                  )
                : yield* Memory.make()),
        destroy:
            persistent || customTables
                ? Effect.all(
                      [
                          customTables?.destroy ??
                              (persistent
                                  ? Effect.all([removeDatabase(name), removeDatabase(`${name}:storage`)], {
                                        concurrency: "unbounded",
                                    })
                                  : Effect.void),
                          persistent ? removeDatabase(`${name}:keys`) : Effect.void,
                          blobBytes instanceof OPFSBlobBytesStore ? blobBytes.clear() : Effect.void,
                      ],
                      { concurrency: "unbounded" }
                  ).pipe(
                      Effect.asVoid,
                      Effect.mapError((cause) => new RuntimeError({ operation: "destroy", cause }))
                  )
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

/** Browser capabilities are available before any partition storage is acquired. */
export const webRuntime = (options: WebRuntimeOptions = {}) =>
    Runtimes.layer(layer(options), {
        browserAuthentication: typeof window !== "undefined" ? createWebBrowserAuthentication() : undefined,
    });

function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(new Error(`IndexedDB database "${name}" could not be deleted.`, { cause: request.error }));
        // "blocked" is a progress event: cooperating connections may still be
        // finishing transactions after close()/versionchange. The deletion is
        // already queued and cannot be cancelled, so await its final result.
    });
}

const removeDatabase = (name: string) =>
    Effect.tryPromise({
        try: () => deleteDatabase(name),
        catch: (cause) => new RuntimeError({ operation: "destroy", cause }),
    });
