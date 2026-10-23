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
import type { Bucket } from "alchemy/Cloudflare/R2/Bucket";
import type { DurableObjectShape } from "alchemy/Cloudflare/Workers/DurableObject";
import type { Worker } from "alchemy/Cloudflare/Workers/Worker";
import type { PlatformServices } from "alchemy/Platform";

export interface OntologyDurableObjectOptions extends Omit<AlchemyOntologyOptions, "bucket" | "ontologyId"> {
    readonly bucket: Bucket | Effect.Effect<Bucket, never, PlatformServices>;
    /** Defaults to the resource name. Instances remain isolated by their DO IDs. */
    readonly ontologyId?: string;
    readonly authorize: OntologyRpcServerOptions["authorize"];
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
            // Same provisioning/binding pattern as Alchemy's encrypted state store.
            const encryptionSecret = options.encryptionKeyring
                ? undefined
                : yield* ReadSecret(
                      Effect.gen(function* () {
                          const store = yield* Store(`${name}Secrets`);
                          const random = yield* Random(`${name}EncryptionKey`, { bytes: 32 });
                          const stack = yield* Stack;
                          const identity = JSON.stringify([stack.name, stack.stage, random.FQN]);
                          const digest = yield* Effect.promise(() =>
                              crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
                          );
                          const secretName = `party-stack-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                          return yield* Secret(`${name}EncryptionKey`, {
                              name: secretName,
                              store,
                              value: random.text,
                          });
                      })
                  );
            return Effect.gen(function* () {
                const key = encryptionSecret
                    ? yield* encryptionSecret.get().pipe(
                          Effect.flatMap((value) =>
                              Effect.tryPromise({
                                  try: () => {
                                      const hex = Redacted.value(value);
                                      if (!/^[0-9a-f]{64}$/u.test(hex))
                                          throw new Error("Invalid encryption key.");
                                      return crypto.subtle.importKey(
                                          "raw",
                                          Uint8Array.from(hex.match(/../gu)!, (pair) =>
                                              Number.parseInt(pair, 16)
                                          ),
                                          "AES-GCM",
                                          false,
                                          ["encrypt", "decrypt"]
                                      );
                                  },
                                  catch: () => new Error("Could not initialize ontology encryption key."),
                              })
                          ),
                          Effect.mapError(() => new Error("Could not initialize ontology encryption key.")),
                          Effect.orDie
                      )
                    : undefined;
                const encryptionKeyring =
                    options.encryptionKeyring ??
                    (key
                        ? {
                              active: Effect.succeed({ id: "v1", key }),
                              get: (id: string) => Effect.succeed(id === "v1" ? key : undefined),
                          }
                        : undefined);
                const { backend } = yield* makeAlchemyOntology({
                    ...options,
                    encryptionKeyring,
                    bucket,
                    ontologyId: options.ontologyId ?? name,
                }).pipe(Effect.orDie);
                const handle = yield* makeOntologyHttpHandler({
                    source: backend.protocol,
                    backend,
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
