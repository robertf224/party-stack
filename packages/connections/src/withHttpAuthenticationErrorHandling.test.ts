import {
    isUnauthenticatedError,
} from "@party-stack/errors";
import { describe, expect, it } from "vitest";
import { withHttpAuthenticationErrorHandling } from "./withHttpAuthenticationErrorHandling.js";

describe("withHttpAuthenticationErrorHandling", () => {
    it("maps HTTP 401 to UnauthenticatedError", async () => {
        const handlers = withHttpAuthenticationErrorHandling({
            fetch: () =>
                Promise.resolve(
                    new Response(null, { status: 401 })
                ),
            createWebSocket: () =>
                Promise.reject(
                    new Error("unexpected websocket")
                ),
        });

        const error = await handlers
            .fetch(new Request("https://example.com"))
            .then(
                () => undefined,
                (reason: unknown) => reason
            );
        expect(isUnauthenticatedError(error)).toBe(true);
    });
});
