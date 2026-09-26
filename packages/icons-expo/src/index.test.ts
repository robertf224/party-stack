import { describe, expect, it } from "vitest";
import { getExpoSymbol, MaterialSymbolArchiveNames } from "./index.js";

describe("Expo icon adapter", () => {
    it("maps universal concepts to typed native symbols only", () => {
        expect(getExpoSymbol("airplane")).toEqual({
            ios: "airplane",
            android: "flight",
        });
        expect(getExpoSymbol("ticket")).toEqual({
            ios: "ticket",
            android: "confirmation_number",
        });
        expect(getExpoSymbol("ticket")).not.toHaveProperty("web");
    });

    it("uses reviewed native mappings without filling explicit gaps", () => {
        expect(getExpoSymbol("activity")).toEqual({
            ios: "waveform.path.ecg",
            android: "ecg_heart",
        });
        expect(getExpoSymbol("rocket")).toEqual({ android: "rocket_launch" });
        expect(MaterialSymbolArchiveNames.activity).toBe("ecg-heart-outline");
        expect(MaterialSymbolArchiveNames["minus-circle"]).toBe("do-not-disturb-on-outline-rounded");
    });
});
