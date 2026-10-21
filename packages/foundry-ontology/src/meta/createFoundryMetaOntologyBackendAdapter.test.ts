import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createFoundryMetaOntologyBackendAdapter } from "./createFoundryMetaOntologyBackendAdapter.js";
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
            const binding = createFoundryMetaOntologyBackendAdapter({ client, refetchInterval });
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const backend = yield* binding.open({});
                        expect(backend.pollIntervalMs?.({ objectType: "ObjectType" })).toBe(
                            refetchInterval ?? false
                        );
                        expect(
                            (yield* Effect.result(
                                backend.invoke({ id: "x", name: "create", parameters: {} })
                            ))._tag
                        ).toBe("Failure");
                    })
                )
            );
        }
    );
});
