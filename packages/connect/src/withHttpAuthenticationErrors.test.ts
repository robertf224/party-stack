import { isUnauthenticatedError } from "@party-stack/ontology-backend";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { withHttpAuthenticationErrors } from "./withHttpAuthenticationErrors.js";

describe("withHttpAuthenticationErrors", () => {
    it("maps HTTP 401 to UnauthenticatedError", async () => {
        const handlers = withHttpAuthenticationErrors({
            fetch: () => Effect.succeed(new Response(null, { status: 401 })),
            createWebSocket: () => Effect.die("unexpected websocket"),
        });

        const result = await Effect.runPromise(
            Effect.result(handlers.fetch(new Request("https://example.com")))
        );
        const error = result._tag === "Failure" ? result.failure : undefined;
        expect(isUnauthenticatedError(error)).toBe(true);
    });
});
