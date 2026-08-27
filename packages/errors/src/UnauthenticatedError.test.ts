import { describe, expect, it } from "vitest";
import {
    isUnauthenticatedError,
    unauthenticated,
    UnauthenticatedError,
} from "./UnauthenticatedError.js";

describe("UnauthenticatedError", () => {
    it("creates a normalized unauthenticated error", () => {
        const error = unauthenticated("Session expired.");

        expect(error).toBeInstanceOf(UnauthenticatedError);
        expect(error).toMatchObject({
            name: "UnauthenticatedError",
            code: "unauthenticated",
            message: "Session expired.",
        });
    });

    it("recognizes errors after structural RPC serialization", () => {
        expect(
            isUnauthenticatedError({
                name: "UnauthenticatedError",
                code: "unauthenticated",
                message: "Session expired.",
            })
        ).toBe(true);
        expect(
            isUnauthenticatedError({
                name: "UnauthenticatedError",
                code: "forbidden",
            })
        ).toBe(false);
    });
});
