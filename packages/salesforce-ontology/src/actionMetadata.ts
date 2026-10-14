import type { SalesforceCrudOperation } from "./utils/ids.js";

export type SalesforceActionMetadata =
    | {
          kind: "flow";
          apiName: string;
      }
    | {
          kind: "standard";
          apiName: string;
      }
    | {
          kind: "crud";
          objectType: string;
          operation: SalesforceCrudOperation;
      };

export function salesforceActionMeta(metadata: SalesforceActionMetadata): Record<string, unknown> {
    return { salesforce: metadata };
}

export function getSalesforceActionMetadata(actionType: {
    meta?: Record<string, unknown>;
}): SalesforceActionMetadata | undefined {
    const value = actionType.meta?.salesforce;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const metadata = value as Record<string, unknown>;
    if ((metadata.kind === "flow" || metadata.kind === "standard") && typeof metadata.apiName === "string") {
        return {
            kind: metadata.kind,
            apiName: metadata.apiName,
        };
    }
    if (
        metadata.kind === "crud" &&
        typeof metadata.objectType === "string" &&
        (metadata.operation === "create" ||
            metadata.operation === "update" ||
            metadata.operation === "delete")
    ) {
        return {
            kind: "crud",
            objectType: metadata.objectType,
            operation: metadata.operation,
        };
    }
    return undefined;
}
