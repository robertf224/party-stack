import { BackendError } from "@party-stack/ontology-backend";
import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";
import { ReadWriteBucket } from "alchemy/Cloudflare/R2/ReadWriteBucket";
import { ReadWriteBucketBinding } from "alchemy/Cloudflare/R2/ReadWriteBucketBinding";
import { DurableObject } from "alchemy/Cloudflare/Workers/DurableObject";
import { DurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Clock, Config, Effect, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { makeAlchemyOntology } from "../../src/alchemy/index.js";
import { Attachments } from "./bucket.js";
import { ir } from "./definition.js";

export class Ontology extends DurableObject<Ontology>()(
    "Ontology",
    Effect.gen(function* () {
        const bucket = yield* ReadWriteBucket(Attachments);
        const state = yield* DurableObjectState;
        const token = yield* Config.Redacted("ONTOLOGY_TOKEN").pipe(Effect.orDie);
        return Effect.gen(function* () {
            const { backend, collectGarbage } = yield* makeAlchemyOntology({
                ir,
                bucket,
                ontologyId: "primary",
            }).pipe(Effect.orDie);
            const handle = yield* makeOntologyHttpHandler({
                source: backend.protocol,
                backend,
                authorize: (_request, headers) =>
                    headers.authorization === `Bearer ${Redacted.value(token)}`
                        ? Effect.void
                        : Effect.fail(
                              new BackendError({
                                  operation: "authorize",
                                  kind: "Rejected",
                                  message: "Unauthorized.",
                                  retryable: false,
                              })
                          ),
            });
            const schedule = Effect.gen(function* () {
                yield* state.storage.setAlarm((yield* Clock.currentTimeMillis) + 60 * 60_000);
            });
            if ((yield* state.storage.getAlarm()) === null) yield* schedule;
            return {
                fetch: Effect.gen(function* () {
                    const request = yield* HttpServerRequest.HttpServerRequest;
                    const webRequest = yield* HttpServerRequest.toWeb(request);
                    const response = yield* Effect.promise(() => handle(webRequest));
                    return HttpServerResponse.fromWeb(response);
                }),
                alarm: () => collectGarbage.pipe(Effect.andThen(schedule), Effect.orDie),
            };
        });
    }).pipe(Effect.provide(ReadWriteBucketBinding))
) {}
