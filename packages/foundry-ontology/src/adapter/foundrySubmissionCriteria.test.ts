import { createOntologyClient } from "@party-stack/foundry-client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { loadFoundrySubmissionCriteria } from "./foundryActionValidation.js";

const condition = { type: "and", and: { conditions: [] } };
const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

it("loads submission criteria through a client whose credentials live only in fetch", async () => {
    // The global fetch is anonymous: nothing may reach Foundry through it.
    const anonymous = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("anonymous request"));
    const requests: { url: string; authorization: string | null }[] = [];
    const egress = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, authorization: request.headers.get("Authorization") });
        if (request.url.includes("/api/v2/ontologies/ontology/actionTypes/create-task"))
            return json({
                apiName: "create-task",
                rid: "ri.actions.main.action-type.create-task",
                status: "ACTIVE",
                parameters: {},
                operations: [],
            });
        if (
            request.url ===
            "https://foundry.example.com/ontology-metadata/api/ontology/ontology/bulkLoadEntities"
        )
            return json({
                actionTypes: [
                    {
                        actionType: {
                            actionTypeLogic: {
                                validation: {
                                    actionTypeLevelValidation: {
                                        rules: {
                                            rule: {
                                                condition,
                                                displayMetadata: { failureMessage: "Denied" },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                ],
            });
        return new Response(null, { status: 404 });
    });
    // Authenticated egress: no token provider, so the client's own one rejects.
    const client = createOntologyClient({
        baseUrl: "https://foundry.example.com",
        ontologyRid: "ontology",
        fetch: egress,
    });

    await expect(
        loadFoundrySubmissionCriteria({ client, actionTypeName: "createTask", userId: "user" })
    ).resolves.toEqual([{ condition, failureMessage: "Denied" }]);
    expect(requests.map((request) => request.url)).toEqual([
        expect.stringContaining("/api/v2/ontologies/ontology/actionTypes/create-task"),
        "https://foundry.example.com/ontology-metadata/api/ontology/ontology/bulkLoadEntities",
    ]);
    // conjure-lite must not try to mint its own bearer token from the client.
    expect(requests[1]?.authorization).toBeNull();
    expect(anonymous).not.toHaveBeenCalled();
});
