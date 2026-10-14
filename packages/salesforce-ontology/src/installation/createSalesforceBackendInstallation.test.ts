import { describe, expect, it } from "vite-plus/test";
import { createSalesforceOntologyRoute } from "./createSalesforceBackendInstallation.js";
import type { OntologyIR } from "@party-stack/ontology";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

const backend = {
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "65.0",
};

describe("createSalesforceOntologyRoute", () => {
    it("creates a scoped metadata route when IR is omitted", () => {
        const route = createSalesforceOntologyRoute({
            ontologyId: "salesforce:tasks",
            objectTypeNames: ["Task", "User"],
        })(backend);

        expect(route.configure === undefined).toBe(true);
        expect(route.configureMeta !== undefined).toBe(true);
        expect(route.matches("salesforce:tasks")).toBe(true);
        expect(route.matches("salesforce:other")).toBe(false);
    });

    it("serves data and metadata from the same IR route", () => {
        const route = createSalesforceOntologyRoute({
            ontologyId: "salesforce:tasks",
            ir,
        })(backend);

        expect(route.configure !== undefined).toBe(true);
        expect(route.configureMeta !== undefined).toBe(true);
    });

    it("forwards live to configured ontology backends", async () => {
        const route = createSalesforceOntologyRoute({
            ontologyId: "salesforce:tasks",
            ir,
            live: false,
        })(backend);
        const configuration = await route.configure!({
            connection: {
                userId: "user-1",
                state: { status: "active" },
            },
            egress: {
                fetch: globalThis.fetch,
            },
            ontologyId: "salesforce:tasks",
        } as never);

        await expect(configuration.backend(ir, {})).resolves.toMatchObject({
            name: "salesforce",
            live: false,
        });
    });
});
