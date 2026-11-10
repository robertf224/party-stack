import { BackendError } from "@party-stack/ontology-backend";
import { Config, Effect, Redacted } from "effect";
import { OntologyDurableObject } from "../../src/alchemy/index.js";
import { Attachments } from "./bucket.js";
import { ir } from "./definition.js";

export const Ontology = OntologyDurableObject(
    "Ontology",
    Effect.gen(function* () {
        const token = yield* Config.Redacted("ONTOLOGY_TOKEN").pipe(Effect.orDie);
        return {
            ir,
            bucket: Attachments,
            ontologyId: "primary",
            dangerouslyAllowInternalAccess: true,
            authenticate: (request) =>
                request.headers.get("authorization") === `Bearer ${Redacted.value(token)}`
                    ? Effect.succeed({})
                    : Effect.fail(
                          new BackendError({
                              operation: "authentication",
                              kind: "Unauthenticated",
                              message: "Unauthorized.",
                              retryable: false,
                          })
                      ),
        };
    })
);
