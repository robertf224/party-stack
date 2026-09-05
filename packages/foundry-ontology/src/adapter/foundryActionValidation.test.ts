import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import {
    type FoundrySubmissionCriterion,
    getFoundryValidationIssues,
    validateFoundryActionDraftCriteria,
} from "./foundryActionValidation.js";
import type { Condition, ConditionValue } from "@osdk/client.unstable";

const adminMocks = vi.hoisted(() => ({
    listGroupMemberships: vi.fn(),
}));

vi.mock("@osdk/foundry.admin", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.admin")>();
    return {
        ...original,
        GroupMemberships: {
            ...original.GroupMemberships,
            list: adminMocks.listGroupMemberships,
        },
    };
});

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

function currentUserGroupIds(): ConditionValue {
    return {
        type: "userProperty",
        userProperty: {
            userId: {
                type: "currentUser",
                currentUser: {},
            },
            propertyValue: {
                type: "groupIds",
                groupIds: {},
            },
        },
    };
}

function staticStringList(...values: string[]): ConditionValue {
    return {
        type: "staticValue",
        staticValue: {
            type: "stringList",
            stringList: {
                strings: values,
            },
        },
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
    beforeEach(() => {
        adminMocks.listGroupMemberships.mockReset();
    });

    it("treats an AND as impossible when any branch is known false", async () => {
        await expect(
            validate({
                "AND cannot pass": and(knownFalse(), unknown()),
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [{ message: "Impossible submission criterion: AND cannot pass" }],
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
                value: [{ message: "Impossible submission criterion: OR cannot pass" }],
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
                value: [{ message: "Impossible submission criterion: NOT cannot pass" }],
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

    it("treats a known omitted parameter as a concrete absence", async () => {
        await expect(
            validateFoundryActionDraftCriteria({
                client: {} as OntologyClient,
                criteria: criteria({
                    "A value is required.": unknown(),
                }),
                userId: "user-1",
                parameters: {},
                knownParameters: new Set(["formInput"]),
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [{ message: "Impossible submission criterion: A value is required." }],
            },
        });
    });

    it("exhausts transitive group-membership pages for the context user", async () => {
        adminMocks.listGroupMemberships
            .mockResolvedValueOnce({
                data: [{ groupId: "regular-users" }],
                nextPageToken: "next-page",
            })
            .mockResolvedValueOnce({
                data: [{ groupId: "another-group" }],
            });

        await expect(
            validate({
                "Only administrators may submit.": {
                    type: "comparison",
                    comparison: {
                        left: currentUserGroupIds(),
                        operator: "INTERSECTS",
                        right: staticStringList("administrators"),
                    },
                },
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [
                    {
                        message:
                            "Impossible submission criterion: Only administrators may submit.",
                    },
                ],
            },
        });
        expect(adminMocks.listGroupMemberships).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            "user-1",
            {
                pageSize: 1_000,
                pageToken: undefined,
                transitive: true,
            }
        );
        expect(adminMocks.listGroupMemberships).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            "user-1",
            {
                pageSize: 1_000,
                pageToken: "next-page",
                transitive: true,
            }
        );
    });
});

describe("getFoundryValidationIssues", () => {
    it("includes parameter paths when Foundry provides a parameter failure message", () => {
        expect(
            getFoundryValidationIssues({
                validation: {
                    result: "INVALID",
                    submissionCriteria: [],
                    parameters: {
                        email: {
                            result: "INVALID",
                            required: true,
                            evaluatedConstraints: [
                                {
                                    type: "stringRegexMatch",
                                    regex: ".+@.+",
                                    configuredFailureMessage: "Enter a valid email address.",
                                },
                            ],
                        },
                    },
                },
            })
        ).toEqual([
            {
                message: "Enter a valid email address.",
                path: ["email"],
            },
        ]);
    });
});
