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
            authorize: (_request, headers) =>
                headers.authorization === `Bearer ${Redacted.value(token)}`
                    ? Effect.void
                    : Effect.fail(
                          new BackendError({
                              operation: "authorize",
                              kind: "Forbidden",
                              message: "Unauthorized.",
                              retryable: false,
                          })
                      ),
        };
    })
);
