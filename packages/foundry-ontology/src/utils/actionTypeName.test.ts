import { describe, expect, it } from "vitest";
import { toFoundryActionTypeName, toOntologyActionTypeName } from "./actionTypeName.js";

describe("actionTypeName", () => {
    it("converts foundry action names to ontology camelCase names", () => {
        expect(toOntologyActionTypeName("create-task")).toBe("createTask");
        expect(toOntologyActionTypeName("complete-task")).toBe("completeTask");
    });

    it("converts ontology action names back to foundry kebab-case names", () => {
        expect(toFoundryActionTypeName("createTask")).toBe("create-task");
        expect(toFoundryActionTypeName("completeTask")).toBe("complete-task");
    });

    it.each([
        [
            "create-warranty-submission-for-b-b-streamline",
            "createWarrantySubmissionForBBStreamline",
        ],
        ["my-u-r-l-field", "myURLField"],
        ["sync-api-v-2-record", "syncApiV_2Record"],
    ])("round trips %s without collapsing word boundaries", (foundryName, ontologyName) => {
        expect(toOntologyActionTypeName(foundryName)).toBe(ontologyName);
        expect(toFoundryActionTypeName(ontologyName)).toBe(foundryName);
    });

    it("preserves namespaced action API names", () => {
        const foundryName =
            "com.palantirfoundry.valinor-enterprises.streamline.complete-task";
        const ontologyName =
            "com.palantirfoundry.valinorEnterprises.streamline.completeTask";

        expect(toOntologyActionTypeName(foundryName)).toBe(ontologyName);
        expect(toFoundryActionTypeName(ontologyName)).toBe(foundryName);
    });
});
