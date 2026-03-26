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
});
