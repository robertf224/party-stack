import { describe, expect, it } from "vitest";
import { certain, uncertain } from "./uncertain.js";

describe("Uncertain", () => {
    it("constructs certain and uncertain values", () => {
        expect(certain("value")).toEqual({
            certain: true,
            value: "value",
        });
        expect(uncertain()).toEqual({
            certain: false,
        });
    });
});
