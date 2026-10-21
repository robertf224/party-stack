import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { EncryptionError, type EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";

const failure = () =>
    new EncryptionError({
        operation: "key",
        kind: "Crypto",
        message: "Browser encryption keys are unavailable.",
    });
const open = (factory: IDBFactory, name: string) =>
    Effect.callback<IDBDatabase, EncryptionError>((resume) => {
        let cancelled = false;
        const request = factory.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("keys");
        request.onsuccess = () => {
            if (cancelled) {
                request.result.close();
                return;
            }
            request.result.onversionchange = () => request.result.close();
            resume(Effect.succeed(request.result));
        };
        request.onerror = () => resume(Effect.fail(failure()));
        request.onblocked = () => {
            cancelled = true;
            resume(Effect.fail(failure()));
        };
        return Effect.sync(() => {
            cancelled = true;
        });
    });

/** Nonextractable WebCrypto keys use native structured cloning in a separate database.
 * This keeps key material out of table exports. It does not isolate keys from same-origin code.
 */
export const makeEncryptionKeyring = Effect.fnUntraced(function* (databaseName: string) {
    const { indexedDB } = yield* IndexedDb.IndexedDb;
    const db = yield* Effect.acquireRelease(open(indexedDB, databaseName), (db) =>
        Effect.sync(() => db.close())
    );
    const record = Schema.Struct({ id: Schema.String, key: Schema.instanceOf(CryptoKey) });
    const decode = Schema.decodeUnknownSync(record);
    type KeyRecord = typeof record.Type;
    const transaction = <A>(
        mode: IDBTransactionMode,
        body: (store: IDBObjectStore, result: (value: A) => void, fail: () => void) => void
    ) =>
        Effect.callback<A, EncryptionError>((resume) => {
            let tx: IDBTransaction;
            let value: A;
            try {
                tx = db.transaction("keys", mode);
                tx.oncomplete = () => resume(Effect.succeed(value));
                tx.onabort = () => resume(Effect.fail(failure()));
                const fail = () => {
                    try {
                        tx.abort();
                    } catch {
                        resume(Effect.fail(failure()));
                    }
                };
                body(
                    tx.objectStore("keys"),
                    (result) => {
                        value = result;
                    },
                    fail
                );
            } catch {
                resume(Effect.fail(failure()));
            }
            return Effect.sync(() => {
                try {
                    tx?.abort();
                } catch {
                    /* Already committed. */
                }
            });
        });
    const get = (id: string) =>
        transaction<KeyRecord | undefined>("readonly", (store, result, fail) => {
            const request = store.get(id);
            request.onsuccess = () => {
                try {
                    result(request.result === undefined ? undefined : decode(request.result));
                } catch {
                    fail();
                }
            };
        });
    const active = Effect.gen(function* () {
        const existing = yield* get("active");
        if (existing) return existing;
        const candidate = yield* Effect.tryPromise({
            try: async () => ({
                id: crypto.randomUUID(),
                key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
                    "encrypt",
                    "decrypt",
                ]),
            }),
            catch: failure,
        });
        // Generation happens before opening the transaction. The second read serializes
        // competing tabs so only one candidate becomes the durable active key.
        return yield* transaction<KeyRecord>("readwrite", (store, result, fail) => {
            const request = store.get("active");
            request.onsuccess = () => {
                try {
                    if (request.result !== undefined) {
                        result(decode(request.result));
                        return;
                    }
                    store.add(candidate, candidate.id);
                    store.add(candidate, "active");
                    result(candidate);
                } catch {
                    fail();
                }
            };
        });
    });
    return {
        active,
        get: (id) => Effect.map(get(id), (entry) => entry?.key),
    } satisfies EncryptionKeyringService;
});
