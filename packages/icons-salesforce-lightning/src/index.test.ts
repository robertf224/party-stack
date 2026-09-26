import { describe, expect, it } from "vitest";
import {
    fromSalesforceLightningIconName,
    getSalesforceActionIconName,
    getSalesforceObjectIconName,
    SalesforceLightningIconNames,
} from "./index.js";

describe("Salesforce Lightning icon mappings", () => {
    it("maps universal names to Lightning utility icons", () => {
        expect(SalesforceLightningIconNames.airplane).toBe("utility/plane");
        expect(SalesforceLightningIconNames.alarm).toBe("custom/custom25");
        expect(fromSalesforceLightningIconName("utility/plane")).toMatchObject({
            name: "airplane",
            meta: { salesforce: { name: "utility/plane" } },
        });
    });

    it("keeps explicit gaps unsupported", () => {
        expect(SalesforceLightningIconNames.activity).toBeUndefined();
        expect(SalesforceLightningIconNames.rocket).toBeUndefined();
    });

    it("does not guess between concepts sharing a reviewed asset", () => {
        expect(fromSalesforceLightningIconName("custom/custom57")).toBeUndefined();
    });

    it("rejects provider icons without a canonical mapping", () => {
        expect(fromSalesforceLightningIconName("standard/vendor_object")).toBeUndefined();
    });

    it("derives conventional standard object and action names", () => {
        expect(getSalesforceObjectIconName("Account")).toBe("standard/account");
        expect(getSalesforceObjectIconName("Invoice__c", true)).toBeUndefined();
        expect(getSalesforceActionIconName("CreateRecord")).toBe("action/create_record");
    });
});
