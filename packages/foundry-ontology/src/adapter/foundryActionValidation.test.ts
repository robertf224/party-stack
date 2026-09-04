import { describe, expect, it } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import {
    type FoundrySubmissionCriterion,
    validateFoundryActionDraftCriteria,
} from "./foundryActionValidation.js";
import type { Condition, ConditionValue } from "@osdk/client.unstable";

function staticString(value: string): ConditionValue {
    return {
        type: "staticValue",
        staticValue: {
            type: "string",
            string: value,
        },
    };
}

function parameter(name: string): ConditionValue {
    return {
        type: "parameterId",
        parameterId: name,
    };
}

function equals(left: ConditionValue, right: ConditionValue): Condition {
    return {
        type: "comparison",
        comparison: {
            left,
            operator: "EQUALS",
            right,
        },
    };
}

function and(...conditions: Condition[]): Condition {
    return {
        type: "and",
        and: { conditions },
    };
}

function or(...conditions: Condition[]): Condition {
    return {
        type: "or",
        or: { conditions },
    };
}

function not(condition: Condition): Condition {
    return {
        type: "not",
        not: { condition },
    };
}

function alwaysTrue(): Condition {
    return {
        type: "true",
        true: {},
    };
}

function knownFalse(): Condition {
    return equals(staticString("actual"), staticString("expected"));
}

function unknown(): Condition {
    return equals(parameter("formInput"), staticString("expected"));
}

function criteria(rules: Record<string, Condition>): FoundrySubmissionCriterion[] {
    return Object.entries(rules).map(([failureMessage, condition]) => ({
        condition,
        failureMessage,
    }));
}

function validate(rules: Record<string, Condition>) {
    return validateFoundryActionDraftCriteria({
        client: {} as OntologyClient,
        criteria: criteria(rules),
        userId: "user-1",
        parameters: {},
    });
}

describe("validateFoundryActionDraftCriteria", () => {
    it("treats an AND as impossible when any branch is known false", async () => {
        await expect(
            validate({
                "AND cannot pass": and(knownFalse(), unknown()),
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: ["Impossible submission criterion: AND cannot pass"],
            },
        });
    });

    it("treats an OR as impossible only when every branch is known false", async () => {
        await expect(
            validate({
                "OR might pass": or(knownFalse(), unknown()),
                "OR cannot pass": or(knownFalse(), knownFalse()),
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: ["Impossible submission criterion: OR cannot pass"],
            },
        });
    });

    it("does not treat NOT of an uncertain condition as impossible", async () => {
        await expect(
            validate({
                "NOT might pass": not(unknown()),
                "NOT cannot pass": not(alwaysTrue()),
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: ["Impossible submission criterion: NOT cannot pass"],
            },
        });
    });

    it("returns uncertain when no criterion is provably impossible", async () => {
        await expect(validate({
            "Only administrators may submit.": unknown(),
        })).resolves.toEqual({
            certain: false,
        });
    });
});
