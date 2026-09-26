import { describe, expect, it } from "vitest";
import { IconNames, isIconName, type IconDescriptor } from "./index.js";

describe("universal icon vocabulary", () => {
    it("contains shared concepts without provider-specific variants", () => {
        expect(IconNames.length).toBeGreaterThan(100);
        expect(isIconName("airplane")).toBe(true);
        expect(isIconName("ticket")).toBe(true);
        expect(isIconName("academic-cap")).toBe(false);
    });

    it("keeps provider data in namespaced meta", () => {
        const icon: IconDescriptor = {
            name: "airplane",
            meta: { example: { name: "plane" } },
        };

        expect(icon).toEqual({
            name: "airplane",
            meta: { example: { name: "plane" } },
        });
    });
});
