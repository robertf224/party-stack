import { makeOntologyServer } from "@party-stack/ontology-server";
import { makeOntologyHttpClient } from "@party-stack/ontology-server/rpc/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { migrateNotesReplica } from "../ontology/migrations";
import { notesMutators } from "../ontology/mutators";
import type { OntologyIR } from "@party-stack/ontology";
import type { RuntimeService } from "@party-stack/runtime";
const requestedDeliveryStrategy = import.meta.env.DEV
    ? import.meta.env.VITE_NOTES_DELIVERY_STRATEGY
    : undefined;
const deliveryStrategy =
    requestedDeliveryStrategy === "snapshot" || requestedDeliveryStrategy === "incremental"
        ? requestedDeliveryStrategy
        : "auto";
export const notesServer = makeOntologyServer({
    enableRealtime: true,
    routes: {
        notes: () =>
            Effect.gen(function* () {
                const client = yield* makeOntologyHttpClient({
                    url: new URL("/api/ontology/rpc", globalThis.location.origin).href,
                }).pipe(Effect.provide(FetchHttpClient.layer));
                return {
                    kind: "replica" as const,
                    deliveryStrategy,
                    mutators: notesMutators,
                    upstream: { client },
                    context: { userId: "device" },
                    namespace: "notes-v1",
                    beforeOpen: (runtime: RuntimeService, ir: OntologyIR) =>
                        migrateNotesReplica(runtime.tables, "notes-v1", ir),
                    dangerouslyAllowInternalAccess: true as const,
                    demand: { idleRetentionMs: 30_000 },
                };
            }),
    },
});
