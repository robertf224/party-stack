import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";
import { ReadWriteBucket } from "alchemy/Cloudflare/R2/ReadWriteBucket";
import { ReadWriteBucketBinding } from "alchemy/Cloudflare/R2/ReadWriteBucketBinding";
import { ReadSecret, ReadSecretBinding, Secret, Store } from "alchemy/Cloudflare/SecretsStore";
import { DurableObject } from "alchemy/Cloudflare/Workers/DurableObject";
import { DurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Random } from "alchemy/Random";
import { Stack } from "alchemy/Stack";
import { Redacted } from "effect";
import { Clock, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { makeAlchemyOntology } from "./backend.js";
import type { AlchemyOntologyOptions } from "./backend.js";
import type { OntologyRpcServerOptions } from "@party-stack/ontology-server/rpc";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { Bucket } from "alchemy/Cloudflare/R2/Bucket";
import type { ReadSecretClient } from "alchemy/Cloudflare/SecretsStore";
import type { DurableObjectShape } from "alchemy/Cloudflare/Workers/DurableObject";
import type { Worker } from "alchemy/Cloudflare/Workers/Worker";
import type { PlatformServices } from "alchemy/Platform";

export interface AlchemyEncryptionKeys {
    /** Key ID for new writes. Keep previous key IDs configured until their ciphertext is retired. */
    readonly active: string;
    /** Secrets contain 32-byte AES keys as 64 hexadecimal characters. Provision/rotate them externally. */
    readonly secrets: Readonly<Record<string, Secret | Effect.Effect<Secret, never, PlatformServices>>>;
}

export interface OntologyDurableObjectOptions extends Omit<AlchemyOntologyOptions, "bucket" | "ontologyId"> {
    readonly bucket: Bucket | Effect.Effect<Bucket, never, PlatformServices>;
    /** Defaults to the resource name. Instances remain isolated by their DO IDs. */
    readonly ontologyId?: string;
    readonly authorize: OntologyRpcServerOptions["authorize"];
    /** Supply existing versioned secrets instead of provisioning the default key. Mutually exclusive with encryptionKeyring. */
    readonly encryptionKeys?: AlchemyEncryptionKeys;
    /** Defaults to an hourly bounded pass with the shared one-hour orphan grace. */
    readonly gc?:
        | false
        | {
              readonly intervalMs?: number;
              readonly orphanGraceMs?: number;
              readonly limit?: number;
          };
}
const PositiveInteger = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
const GC = Schema.Struct({
    intervalMs: Schema.optional(PositiveInteger),
    orphanGraceMs: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
    ),
    limit: Schema.optional(PositiveInteger),
});

/** An Alchemy DO resource with native storage, authenticated Effect RPC and a bounded GC alarm. */
export function OntologyDurableObject(
    name: string,
    input: OntologyDurableObjectOptions | Effect.Effect<OntologyDurableObjectOptions, never, PlatformServices>
): Effect.Effect<DurableObject<DurableObjectShape>, never, Worker> {
    return DurableObject<DurableObjectShape>()(
        name,
        Effect.gen(function* () {
            const options = yield* Effect.isEffect(input) ? input : Effect.succeed(input);
            const gc = options.gc === false ? false : Schema.decodeUnknownSync(GC)(options.gc ?? {});
            const bucket = yield* ReadWriteBucket(options.bucket);
            const state = yield* DurableObjectState;
            if (options.encryptionKeyring && options.encryptionKeys)
                return yield* Effect.die(new Error("Supply encryptionKeys or encryptionKeyring, not both."));
            const configured = options.encryptionKeys;
            if (configured && (!configured.active || !Object.hasOwn(configured.secrets, configured.active)))
                return yield* Effect.die(
                    new Error("The active encryption key must have a configured secret.")
                );
            const defaultSecret = Effect.gen(function* () {
                const store = yield* Store(`${name}Secrets`);
                const random = yield* Random(`${name}EncryptionKey`, { bytes: 32 });
                const stack = yield* Stack;
                const identity = JSON.stringify([stack.name, stack.stage, random.FQN]);
                const digest = yield* Effect.promise(() =>
                    crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
                );
                const secretName = `party-stack-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                return yield* Secret(`${name}EncryptionKey`, { name: secretName, store, value: random.text });
            });
            const clients = new Map<string, ReadSecretClient>();
            if (!options.encryptionKeyring)
                for (const [id, secret] of Object.entries(configured?.secrets ?? { v1: defaultSecret }))
                    clients.set(id, yield* ReadSecret(secret));
            return Effect.gen(function* () {
                const keys = new Map<string, CryptoKey>();
                for (const [id, client] of clients) {
                    const key = yield* client.get().pipe(
                        Effect.flatMap((value) =>
                            Schema.decodeUnknownEffect(
                                Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/iu))
                            )(Redacted.value(value))
                        ),
                        Effect.flatMap((hex) =>
                            Effect.tryPromise(() =>
                                crypto.subtle.importKey(
                                    "raw",
                                    Uint8Array.from(hex.match(/../gu)!, (pair) => Number.parseInt(pair, 16)),
                                    "AES-GCM",
                                    false,
                                    ["encrypt", "decrypt"]
                                )
                            )
                        ),
                        Effect.mapError(() => new Error("Could not initialize ontology encryption key.")),
                        Effect.orDie
                    );
                    keys.set(id, key);
                }
                const active = configured?.active ?? "v1";
                const encryptionKeyring: EncryptionKeyringService = options.encryptionKeyring ?? {
                    active: Effect.succeed({ id: active, key: keys.get(active)! }),
                    get: (id) => Effect.succeed(keys.get(id)),
                };
                const { backend } = yield* makeAlchemyOntology({
                    ...options,
                    encryptionKeyring,
                    bucket,
                    ontologyId: options.ontologyId ?? name,
                }).pipe(Effect.orDie);
                const handle = yield* makeOntologyHttpHandler({
                    backend,
                    ir: options.ir,
                    authorize: options.authorize,
                });
                const schedule =
                    gc === false
                        ? Effect.void
                        : Effect.gen(function* () {
                              yield* state.storage.setAlarm(
                                  (yield* Clock.currentTimeMillis) + (gc.intervalMs ?? 60 * 60_000)
                              );
                          });
                // Preserve an earlier alarm when waking/reconstructing the instance.
                if (gc !== false && (yield* state.storage.getAlarm()) === null) yield* schedule;
                return {
                    fetch: Effect.gen(function* () {
                        const request = yield* HttpServerRequest.HttpServerRequest;
                        const webRequest = yield* HttpServerRequest.toWeb(request);
                        return HttpServerResponse.fromWeb(yield* Effect.promise(() => handle(webRequest)));
                    }),
                    alarm: () =>
                        gc === false
                            ? Effect.void
                            : backend
                                  .collectGarbage({ orphanGraceMs: gc.orphanGraceMs, limit: gc.limit })
                                  .pipe(Effect.andThen(schedule), Effect.orDie),
                };
            });
        }).pipe(Effect.provide(ReadWriteBucketBinding), Effect.provide(ReadSecretBinding))
    );
}
