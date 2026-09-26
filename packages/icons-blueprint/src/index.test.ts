import { describe, expect, it } from "vitest";
import { fromBlueprintIconName, getBlueprintIconName, toBlueprintIconName } from "./index.js";

describe("Blueprint icon adapter", () => {
    it("maps universal concepts to typed Blueprint names", () => {
        expect(getBlueprintIconName("airplane")).toBe("airplane");
        expect(getBlueprintIconName("add")).toBe("plus");
    });

    it("keeps explicit provider gaps unsupported", () => {
        expect(getBlueprintIconName("ticket")).toBeUndefined();
    });

    it("rejects provider icons without a unique canonical mapping", () => {
        expect(fromBlueprintIconName("future-blueprint-icon")).toBeUndefined();
        expect(fromBlueprintIconName("notifications")).toBeUndefined();
    });

    it("maps known source names to universal concepts", () => {
        const icon = fromBlueprintIconName("issue");
        expect(icon).toBeDefined();
        if (!icon) {
            throw new Error("Expected issue to have a canonical mapping.");
        }
        expect(icon.name).toBe("alert");
        expect(toBlueprintIconName(icon)).toBe("issue");
    });
});
