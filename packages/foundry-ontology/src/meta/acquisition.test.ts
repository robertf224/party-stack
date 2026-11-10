import { objectSubset } from "@party-stack/ontology-backend/subset";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeFoundryMetadataBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";
const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ontology",
    tokenProvider: async () => "token",
    fetch: globalThis.fetch,
};
describe("native metadata binding", () => {
    it.each([30_000, false, undefined] as const)(
        "declares refresh policy %s without constructing collections",
        async (refetchInterval) => {
            const binding = makeFoundryMetadataBackend({ client, refetchInterval });
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const backend = binding;
                        expect(backend.refresh?.(objectSubset("ObjectType"))?.pollIntervalMs).toBe(
                            refetchInterval ?? false
                        );
                        expect(
                            (yield* Effect.result(
                                backend.applyAction({ id: "x", name: "create", parameters: {} })
                            ))._tag
                        ).toBe("Failure");
                    })
                )
            );
        }
    );
});
