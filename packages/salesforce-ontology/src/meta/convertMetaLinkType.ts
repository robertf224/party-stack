import type { MetaLinkType } from "@party-stack/ontology";
import type { SalesforceFieldDescribe, SalesforceSObjectDescribe } from "@party-stack/salesforce-client";
import { salesforceLinkTypeId } from "../utils/ids.js";

/**
 * Create Party Stack link types for single-target Salesforce reference fields.
 * Polymorphic references (multiple referenceTo values) are intentionally omitted
 * and remain scalar ID properties on the source object.
 */
export function convertSalesforceMetaLinkTypes(describes: SalesforceSObjectDescribe[]): MetaLinkType[] {
    const links: MetaLinkType[] = [];

    for (const describe of describes) {
        for (const field of describe.fields) {
            const link = convertReferenceFieldToLink(describe.name, field);
            if (link) {
                links.push(link);
            }
        }
    }

    return links;
}

function convertReferenceFieldToLink(
    sourceObjectType: string,
    field: SalesforceFieldDescribe
): MetaLinkType | null {
    if (field.type !== "reference") {
        return null;
    }
    const referenceTo = field.referenceTo ?? [];
    if (referenceTo.length !== 1) {
        return null;
    }

    const targetObjectType = referenceTo[0]!;
    const relationshipName = field.relationshipName ?? `${field.name.replace(/Id$/, "")}`;
    const inverseName = `${camelCaseSafe(sourceObjectType)}s`;

    return {
        id: salesforceLinkTypeId(sourceObjectType, field.name),
        source: {
            objectType: sourceObjectType,
            name: inverseName,
            displayName: `${describeLabel(sourceObjectType)}s`,
        },
        target: {
            objectType: targetObjectType,
            name: relationshipName,
            displayName: field.label || relationshipName,
        },
        foreignKey: field.name,
        // A reference field on the source points to one target.
        cardinality: "many",
    };
}

function camelCaseSafe(value: string): string {
    if (!value) return value;
    return value.charAt(0).toLowerCase() + value.slice(1);
}

function describeLabel(value: string): string {
    return value.replace(/__/g, " ").replace(/_/g, " ");
}
