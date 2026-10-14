import { salesforceActionMeta } from "../actionMetadata.js";
import {
    salesforceCrudActionTypeId,
    salesforceCrudActionTypeName,
    type SalesforceCrudOperation,
} from "../utils/ids.js";
import { convertSalesforceFieldType } from "./convertMetaTypeDef.js";
import type { MetaActionType, TypeDef } from "@party-stack/ontology";
import type { SalesforceFieldDescribe, SalesforceSObjectDescribe } from "@party-stack/salesforce-client";

const COMPOUND_PARENT_TYPES = new Set(["address", "location"]);

function optional(type: TypeDef): TypeDef {
    return type.kind === "optional" ? type : { kind: "optional", value: { type } };
}

function writableFieldParameter(field: SalesforceFieldDescribe, operation: "create" | "update") {
    let type = convertSalesforceFieldType(field);
    if (operation === "update" || (operation === "create" && field.defaultedOnCreate)) {
        type = optional(type);
    }
    return {
        name: field.name,
        displayName: field.label || field.name,
        description: field.inlineHelpText ?? undefined,
        type,
    };
}

function action(
    describe: SalesforceSObjectDescribe,
    operation: SalesforceCrudOperation,
    parameters: MetaActionType["parameters"]
): MetaActionType {
    const verb = operation === "create" ? "Create" : operation === "update" ? "Update" : "Delete";
    const values = parameters
        .filter((parameter) => parameter.name !== "recordId")
        .map((parameter) => ({
            property: [parameter.name],
            value: {
                kind: "inputReference" as const,
                value: { name: parameter.name },
            },
        }));
    const logic: MetaActionType["logic"] =
        operation === "create"
            ? [
                  {
                      kind: "createObject",
                      value: {
                          objectType: describe.name,
                          values,
                      },
                  },
              ]
            : operation === "update"
              ? [
                    {
                        kind: "updateObject",
                        value: {
                            object: {
                                name: "recordId",
                            },
                            values,
                        },
                    },
                ]
              : [
                    {
                        kind: "deleteObject",
                        value: {
                            object: {
                                name: "recordId",
                            },
                        },
                    },
                ];
    return {
        id: salesforceCrudActionTypeId(operation, describe.name),
        meta: salesforceActionMeta({
            kind: "crud",
            objectType: describe.name,
            operation,
        }),
        name: salesforceCrudActionTypeName(operation, describe.name),
        displayName: `${verb} ${describe.label}`,
        parameters,
        logic,
    };
}

function isWritableField(field: SalesforceFieldDescribe, operation: "create" | "update"): boolean {
    if (COMPOUND_PARENT_TYPES.has(field.type)) return false;
    if (field.calculated || field.autoNumber) return false;
    return operation === "create" ? field.createable : field.updateable;
}

export function synthesizeSalesforceCrudActionTypes(describe: SalesforceSObjectDescribe): MetaActionType[] {
    const actions: MetaActionType[] = [];
    if (describe.createable) {
        actions.push(
            action(
                describe,
                "create",
                describe.fields
                    .filter((field) => isWritableField(field, "create"))
                    .map((field) => writableFieldParameter(field, "create"))
            )
        );
    }
    if (describe.updateable) {
        actions.push(
            action(describe, "update", [
                {
                    name: "recordId",
                    displayName: `${describe.label} ID`,
                    type: {
                        kind: "objectReference",
                        value: { objectType: describe.name },
                    },
                },
                ...describe.fields
                    .filter((field) => isWritableField(field, "update"))
                    .map((field) => writableFieldParameter(field, "update")),
            ])
        );
    }
    if (describe.deletable) {
        actions.push(
            action(describe, "delete", [
                {
                    name: "recordId",
                    displayName: `${describe.label} ID`,
                    type: {
                        kind: "objectReference",
                        value: { objectType: describe.name },
                    },
                },
            ])
        );
    }
    return actions;
}
