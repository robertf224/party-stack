import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { withHttpRetryHandling } from "./withHttpRetryHandling.js";

describe("withHttpRetryHandling", () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    it("retries idempotent rate-limited requests", async () => {
        vi.useFakeTimers();
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 429,
                    headers: {
                        "retry-after": "1",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 204,
                })
            );
        const handlers = withHttpRetryHandling(
            {
                fetch,
                createWebSocket: () =>
                    Promise.reject(
                        new Error(
                            "Unexpected WebSocket."
                        )
                    ),
            },
            {
                maxDelayMs: 100,
            }
        );

        const responsePromise = handlers.fetch(
            new Request(
                "https://example.com/data"
            )
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(fetch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(900);
        const response = await responsePromise;

        expect(response.status).toBe(204);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("retries rate-limited requests regardless of method", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 429,
                })
            )
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 204,
                })
            );
        const handlers = withHttpRetryHandling(
            {
                fetch,
                createWebSocket: () =>
                    Promise.reject(
                        new Error(
                            "Unexpected WebSocket."
                        )
                    ),
            },
            {
                baseDelayMs: 0,
            }
        );

        const response = await handlers.fetch(
            new Request(
                "https://example.com/action",
                { method: "POST" }
            )
        );

        expect(response.status).toBe(204);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-429 responses", async () => {
        const fetch = vi.fn(() =>
            Promise.resolve(
                new Response(null, {
                    status: 500,
                })
            )
        );
        const handlers = withHttpRetryHandling({
            fetch,
            createWebSocket: () =>
                Promise.reject(
                    new Error(
                        "Unexpected WebSocket."
                    )
                ),
        });

        const response = await handlers.fetch(
            new Request(
                "https://example.com/data"
            )
        );

        expect(response.status).toBe(500);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("retries service-unavailable responses", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 503,
                })
            )
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 204,
                })
            );
        const handlers = withHttpRetryHandling(
            {
                fetch,
                createWebSocket: () =>
                    Promise.reject(
                        new Error(
                            "Unexpected WebSocket."
                        )
                    ),
            },
            {
                baseDelayMs: 0,
            }
        );

        const response = await handlers.fetch(
            new Request(
                "https://example.com/data"
            )
        );

        expect(response.status).toBe(204);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
