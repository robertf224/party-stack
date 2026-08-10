import type { MetaObjectProperty, MetaObjectType } from "@party-stack/ontology";
import type { SalesforceFieldDescribe, SalesforceSObjectDescribe } from "@party-stack/salesforce-client";
import { salesforceObjectTypeId, salesforcePropertyId } from "../utils/ids.js";
import { convertSalesforceFieldType } from "./convertMetaTypeDef.js";

const COMPOUND_PARENT_TYPES = new Set(["address", "location"]);

function isQueryableField(field: SalesforceFieldDescribe): boolean {
    if (COMPOUND_PARENT_TYPES.has(field.type)) {
        // Parent compound fields are not selectable in SOQL; components are.
        return false;
    }
    return true;
}

function chooseTitleProperty(fields: SalesforceFieldDescribe[]): string | undefined {
    const preferred = ["Name", "Subject", "Title", "Label", "DeveloperName"];
    for (const name of preferred) {
        if (fields.some((field) => field.name === name && field.type !== "reference")) {
            return name;
        }
    }
    const firstString = fields.find(
        (field) =>
            field.name !== "Id" &&
            (field.type === "string" || field.type === "textarea" || field.type === "picklist")
    );
    return firstString?.name;
}

export function convertSalesforceMetaObjectType(describe: SalesforceSObjectDescribe): MetaObjectType {
    const properties = describe.fields
        .filter(isQueryableField)
        .map((field) => convertSalesforceObjectProperty(describe.name, field));

    return {
        id: salesforceObjectTypeId(describe.name),
        name: describe.name,
        displayName: describe.label,
        pluralDisplayName: describe.labelPlural,
        primaryKey: "Id",
        title: chooseTitleProperty(describe.fields),
        properties,
    };
}

function convertSalesforceObjectProperty(
    sObjectName: string,
    field: SalesforceFieldDescribe
): MetaObjectProperty {
    return {
        id: salesforcePropertyId(sObjectName, field.name),
        name: field.name,
        displayName: field.label || field.name,
        description: field.inlineHelpText ?? undefined,
        type: convertSalesforceFieldType(field),
    };
}
