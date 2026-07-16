import { createInMemoryBlobStore } from "@party-stack/blobs";
import { describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { createLiveOntology, type OntologyDefinition } from "./LiveOntology.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [
        {
            name: "currentUser",
            displayName: "Current User",
            parameters: [],
            returnType: o.string({}),
        },
    ],
};

describe("createLiveOntology", () => {
    it("uses static context and keys blob storage by user and ontology", async () => {
        const context = { account: { id: "user-1" }, role: "editor" };
        let blobStoreKey: { owner: string; namespace: string } | undefined;
        let receivedContext: Record<string, unknown> | undefined;
        const adapter: OntologyAdapter = {
            name: "test",
            getCollectionOptions: () => {
                throw new Error("unexpected collection");
            },
            applyAction: () => Promise.reject(new Error("unexpected action")),
            runQueryFunction: (_name, _parameters, live) => {
                receivedContext = live.context;
                return Promise.resolve(context.account.id);
            },
        };

        const ontology = createLiveOntology<OntologyDefinition, typeof context>({
            id: "ontology-1",
            ir,
            adapter,
            context,
            getUserId: (liveContext) => liveContext.account.id,
            blobStore: (key) => {
                blobStoreKey = key;
                return createInMemoryBlobStore();
            },
        });

        await expect(ontology.queryFunctions.currentUser!({})).resolves.toBe("user-1");
        expect(receivedContext).toBe(context);
        expect(blobStoreKey).toEqual({
            owner: "user-1",
            namespace: "ontology-1",
        });
        await ontology.cleanup();
    });
});
