import { Worker } from "alchemy/Cloudflare/Workers/Worker";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { Ontology } from "./ontology.js";

export default Worker(
    "OntologyServer",
    { main: import.meta.url },
    Effect.gen(function* () {
        const ontologies = yield* Ontology;
        return {
            fetch: Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                return yield* ontologies.getByName("primary").fetch(request);
            }),
        };
    })
);
