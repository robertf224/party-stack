import { describe, expect, it } from "vitest";
import { isNotDeclarativeActionType } from "./actionTypeCollectionOptions.js";
import type { ActionTypeV2 } from "@osdk/foundry.ontologies";

function actionType(overrides: Partial<ActionTypeV2> = {}): ActionTypeV2 {
    return {
        apiName: "streamline-create-token",
        status: "EXPERIMENTAL",
        parameters: {},
        rid: "ri.actions.main.action-type.c38c41b6-46be-42d0-8f07-2d3e424de2ea",
        operations: [],
        ...overrides,
    };
}

describe("isNotDeclarativeActionType", () => {
    it("treats empty operations as non-declarative", () => {
        expect(isNotDeclarativeActionType(actionType())).toBe(true);
    });

    it("treats actions with operations as declarative", () => {
        expect(
            isNotDeclarativeActionType(
                actionType({
                    apiName: "create-task",
                    operations: [{ type: "createObject", objectTypeApiName: "Task" }],
                })
            )
        ).toBe(false);
    });
});
