import { describe, expect, it } from "vitest";
import type { OntologyIR } from "@party-stack/ontology";
import { createSalesforceOntologyRoute } from "./createSalesforceBackendInstallation.js";

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

    it("defers IR metadata projection to the installation", () => {
        const route = createSalesforceOntologyRoute({
            ontologyId: "salesforce:tasks",
            ir,
        })(backend);

        expect(route.configure !== undefined).toBe(true);
        expect(route.configureMeta === undefined).toBe(true);
    });
});
