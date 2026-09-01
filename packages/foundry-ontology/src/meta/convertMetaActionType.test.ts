import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { convertFoundryMetaActionType } from "./convertMetaActionType.js";
import type { ActionParameterV2, ActionTypeFullMetadata } from "@osdk/foundry.ontologies";

function actionType(parameters: Record<string, ActionParameterV2>): ActionTypeFullMetadata {
    return {
        actionType: {
            apiName: "validated-action",
            displayName: "Validated action",
            status: "EXPERIMENTAL",
            parameters,
            rid: "ri.actions.main.action-type.example",
            operations: [],
        },
        fullLogicRules: [],
    };
}

describe("convertFoundryMetaActionType parameter validation", () => {
    it("maps the Foundry action type RID to the runtime metadata ID", () => {
        expect(convertFoundryMetaActionType(actionType({}))).toMatchObject({
            id: "ri.actions.main.action-type.example",
            name: "validatedAction",
        });
    });

    it("converts closed one-of string validation to an enum constraint", () => {
        const result = convertFoundryMetaActionType(
            actionType({
                status: {
                    displayName: "Status",
                    dataType: { type: "string" },
                    required: true,
                    typeClasses: [],
                    validation: {
                        defaultValidation: {
                            allowedValues: {
                                type: "oneOf",
                                options: [
                                    { displayName: "Open", value: "open" },
                                    { displayName: "Closed", value: "closed" },
                                ],
                                otherValuesAllowed: false,
                            },
                        },
                    },
                },
            })
        );

        expect(result.parameters[0]?.type).toEqual({
            kind: "string",
            value: {
                constraint: {
                    kind: "enum",
                    value: {
                        options: [
                            { value: "open", label: "Open" },
                            { value: "closed", label: "Closed" },
                        ],
                    },
                },
            },
        });
    });

    it("does not constrain one-of validation that permits other values", () => {
        const result = convertFoundryMetaActionType(
            actionType({
                status: {
                    displayName: "Status",
                    dataType: { type: "string" },
                    required: true,
                    typeClasses: [],
                    validation: {
                        defaultValidation: {
                            allowedValues: {
                                type: "oneOf",
                                options: [{ displayName: "Open", value: "open" }],
                                otherValuesAllowed: true,
                            },
                        },
                    },
                },
            })
        );

        expect(result.parameters[0]?.type).toEqual({
            kind: "string",
            value: {},
        });
    });

    it("converts text regex validation to a regex constraint", () => {
        const result = convertFoundryMetaActionType(
            actionType({
                postalCode: {
                    displayName: "Postal code",
                    dataType: { type: "string" },
                    required: false,
                    typeClasses: [],
                    validation: {
                        defaultValidation: {
                            allowedValues: {
                                type: "text",
                                regex: "^\\d{5}$",
                            },
                        },
                    },
                },
            })
        );

        expect(result.parameters[0]?.type).toEqual({
            kind: "optional",
            value: {
                type: {
                    kind: "string",
                    value: {
                        constraint: {
                            kind: "regex",
                            value: { regex: "^\\d{5}$" },
                        },
                    },
                },
            },
        });
    });

    it("references value types so their existing constraints are reused", () => {
        const result = convertFoundryMetaActionType(
            actionType({
                postalCode: {
                    displayName: "Postal code",
                    dataType: { type: "string" },
                    required: true,
                    typeClasses: [],
                    validation: {
                        defaultValidation: {
                            allowedValues: {
                                type: "valueType",
                                apiName: "PostalCode",
                                rid: "ri.ontology.main.value-type.example",
                                versionId: "1",
                            },
                        },
                    },
                },
            })
        );

        expect(result.parameters[0]?.type).toEqual({
            kind: "ref",
            value: { name: "PostalCode" },
        });
    });

    it("maps Foundry current user arguments to the canonical user context", () => {
        const metadata = actionType({});
        metadata.fullLogicRules = [
            {
                type: "createObject",
                objectTypeApiName: "Task",
                propertyArguments: {
                    createdBy: {
                        type: "currentUser",
                    },
                },
                structPropertyArguments: {},
            } as never,
        ];

        expect(
            convertFoundryMetaActionType(
                metadata
            ).logic
        ).toEqual([
            {
                kind: "createObject",
                value: {
                    objectType: "Task",
                    values: [
                        {
                            property: [
                                "createdBy",
                            ],
                            value: {
                                kind: "contextReference",
                                value: {
                                    path: [
                                        "user",
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
        ]);
    });
});

describe("convertFoundryMetaActionType OMS prefills", () => {
    it("converts static and object-property prefills without changing action defaults", () => {
        const result = convertFoundryMetaActionType(
            actionType({
                assignee: {
                    displayName: "Assignee",
                    dataType: {
                        type: "object",
                        objectTypeApiName: "User",
                        objectApiName: "User",
                    },
                    required: true,
                    typeClasses: [],
                },
                assigneeName: {
                    displayName: "Assignee name",
                    dataType: { type: "string" },
                    required: false,
                    typeClasses: [],
                },
                notes: {
                    displayName: "Notes",
                    dataType: { type: "string" },
                    required: false,
                    typeClasses: [],
                },
            }),
            {
                actionTypeLogic: {
                    validation: {
                        parameterValidations: {
                            assigneeName: {
                                defaultValidation: {
                                    display: {
                                        prefill: {
                                            type: "objectParameterPropertyValue",
                                            objectParameterPropertyValue: {
                                                parameterId: "assignee",
                                                propertyTypeId: "name",
                                            },
                                        },
                                    },
                                },
                            },
                            notes: {
                                defaultValidation: {
                                    display: {
                                        prefill: {
                                            type: "staticValue",
                                            staticValue: {
                                                type: "string",
                                                string: "from-foundry",
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            } as never
        );

        expect(result.parameters).toMatchObject([
            {
                name: "assignee",
            },
            {
                name: "assigneeName",
                prefills: [
                    {
                        kind: "objectProperty",
                        value: {
                            fieldPath: [],
                            parameter: "assignee",
                            property: ["name"],
                        },
                    },
                ],
            },
            {
                name: "notes",
                prefills: [
                    {
                        kind: "literal",
                        value: {
                            fieldPath: [],
                            value: "from-foundry",
                        },
                    },
                ],
            },
        ]);
        expect(result.parameters[2]?.defaultValue).toBeUndefined();
    });

    it("preserves Foundry object-query prefills for live consumers", () => {
        const objectSet = {
            objectSet: {
                startingObjectSet: {
                    type: "base",
                    base: { objectTypeId: "User" },
                },
                transforms: [],
            },
            conditionValues: {},
        };
        const result = convertFoundryMetaActionType(
            actionType({
                assignee: {
                    displayName: "Assignee",
                    dataType: {
                        type: "object",
                        objectTypeApiName: "User",
                        objectApiName: "User",
                    },
                    required: false,
                    typeClasses: [],
                },
            }),
            {
                actionTypeLogic: {
                    validation: {
                        parameterValidations: {
                            assignee: {
                                defaultValidation: {
                                    display: {
                                        prefill: {
                                            type: "objectQueryPrefill",
                                            objectQueryPrefill: { objectSet },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            } as never
        );

        expect(result.parameters[0]?.prefills).toEqual([
            {
                kind: "foundryObjectQuery",
                value: {
                    fieldPath: [],
                    objectType: "User",
                    objectSet,
                },
            },
        ]);
    });

    it("normalizes typed OMS date and list values", () => {
        const result = convertFoundryMetaActionType(
            actionType({
                dueDate: {
                    displayName: "Due date",
                    dataType: { type: "date" },
                    required: false,
                    typeClasses: [],
                },
                tags: {
                    displayName: "Tags",
                    dataType: {
                        type: "array",
                        subType: { type: "string" },
                    },
                    required: false,
                    typeClasses: [],
                },
            }),
            {
                actionTypeLogic: {
                    validation: {
                        parameterValidations: {
                            dueDate: {
                                defaultValidation: {
                                    display: {
                                        prefill: {
                                            type: "staticValue",
                                            staticValue: {
                                                type: "date",
                                                date: { dateValue: "2026-08-31" },
                                            },
                                        },
                                    },
                                },
                            },
                            tags: {
                                defaultValidation: {
                                    display: {
                                        prefill: {
                                            type: "staticValue",
                                            staticValue: {
                                                type: "stringList",
                                                stringList: {
                                                    strings: ["priority", "customer"],
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            } as never
        );

        const dueDatePrefill = result.parameters[0]?.prefills?.[0];
        const tagsPrefill = result.parameters[1]?.prefills?.[0];
        expect(dueDatePrefill?.kind).toBe("literal");
        expect(tagsPrefill?.kind).toBe("literal");
        if (dueDatePrefill?.kind !== "literal" || tagsPrefill?.kind !== "literal") {
            throw new Error("Expected literal prefills.");
        }
        const date = dueDatePrefill.value.value;
        expect(date).toBeInstanceOf(Temporal.PlainDate);
        expect((date as Temporal.PlainDate).toString()).toBe("2026-08-31");
        expect(tagsPrefill.value.value).toEqual([
            "priority",
            "customer",
        ]);
    });

});
