import { base64url } from "jose";
import { describe, expect, it } from "vitest";
import { getTokenDetails } from "./getTokenDetails.js";

describe("getTokenDetails", () => {
    it("decodes Foundry user and expiration claims", () => {
        const subject = Uint8Array.from([
            251, 255, 254, 253, 252, 251, 250, 249, 248, 247, 246, 245, 244, 243, 242, 241,
        ]);
        const encodedSubject = btoa(String.fromCharCode(...subject));
        const token = [
            base64url.encode(JSON.stringify({ alg: "none" })),
            base64url.encode(
                JSON.stringify({
                    sub: encodedSubject,
                    exp: 1_700_000_000,
                })
            ),
            "",
        ].join(".");

        expect(getTokenDetails(token)).toEqual({
            userId: "fbfffefd-fcfb-faf9-f8f7-f6f5f4f3f2f1",
            expiresAt: 1_700_000_000_000,
        });
    });
});
