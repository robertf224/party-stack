import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeServerConnectClient } from "./serverClient.js";

describe("server-owned browser authorization", () => {
    it("opens a browser presentation and returns only the server's completion metadata", async () => {
        const close = vi.fn();
        const open = vi.fn(() =>
            Effect.succeed({
                callbackUrl: "https://app.example/done?connectAttempt=attempt&state=attempt",
            })
        );
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            expect(init?.credentials).toBe("include");
            return new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/begin")
                ? Response.json({
                      id: "attempt",
                      authorizationUrl: "https://provider.example/authorize?state=attempt",
                  })
                : Response.json({ status: "completed", connectionId: "connection" });
        });
        const client = makeServerConnectClient({
            baseUrl: "https://app.example/connect/",
            returnUrl: "https://app.example/done",
            fetch,
            browser: {
                start: () => Effect.acquireRelease(Effect.succeed({ open }), () => Effect.sync(close)),
            },
        });
        const result = await Effect.runPromise(
            client.authorize({ connectorId: "connector", browserPresentation: "popup" })
        );
        expect(result).toEqual({ status: "completed", connectionId: "connection" });
        expect(close).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("rejects completion for another attempt", async () => {
        const close = vi.fn();
        const client = makeServerConnectClient({
            baseUrl: "https://app.example/connect/",
            returnUrl: "https://app.example/done",
            fetch: async () =>
                Response.json({
                    id: "expected",
                    authorizationUrl: "https://provider.example/authorize?state=expected",
                }),
            browser: {
                start: () =>
                    Effect.acquireRelease(
                        Effect.succeed({
                            open: () =>
                                Effect.succeed({
                                    callbackUrl: "https://app.example/done?connectAttempt=other",
                                }),
                        }),
                        () => Effect.sync(close)
                    ),
            },
        });
        await expect(Effect.runPromise(client.authorize({ connectorId: "connector" }))).rejects.toThrow(
            /did not match/
        );
        expect(close).toHaveBeenCalledOnce();
    });
});
