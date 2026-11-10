import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { httpClient } from "./http.js";

test("the SDK HTTP client retains fetch configuration for requests after acquisition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = {
                    types: [],
                    linkTypes: [],
                    actionTypes: [],
                    queryFunctionTypes: [],
                    objectTypes: [
                        {
                            name: "Issue",
                            displayName: "Issue",
                            pluralDisplayName: "Issues",
                            primaryKey: "id",
                            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
                        },
                    ],
                };
                const backend = yield* makeOwnedBackend({
                    namespace: "http-sdk",
                    mutators: {},
                    ir,
                    tables: yield* Memory.make(),
                });
                const requests: Request[] = [];
                const handler = yield* makeOntologyHttpHandler({
                    enableRealtime: true,
                    backend,
                    ir,
                    authorize: () => Effect.void,
                });
                const root = yield* httpClient("https://ontology.test/rpc", {
                    headers: { "x-sdk-test": "present" },
                    credentials: "include",
                    fetch: async (input, init) => {
                        const request = new Request(input, init);
                        requests.push(request);
                        return handler(request);
                    },
                });
                const client = yield* root.ontology();
                expect((yield* client.backend.loadSubset(objectSubset("Issue"))).rows).toEqual([]);
                expect(requests.length).toBeGreaterThanOrEqual(2);
                for (const request of requests) {
                    expect(request.headers.get("x-sdk-test")).toBe("present");
                    expect(request.credentials).toBe("include");
                }
            })
        )
    );
});

test("relative SDK endpoints require a browser base URL at acquisition, not at import", async () => {
    const acquisition = httpClient("/rpc");
    const result = await Effect.runPromise(Effect.scoped(acquisition).pipe(Effect.result));
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
});
