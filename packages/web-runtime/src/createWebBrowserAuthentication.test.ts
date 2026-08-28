import { BrowserAuthenticationCancelledError } from "@party-stack/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebBrowserAuthentication } from "./createWebBrowserAuthentication.js";

describe("createWebBrowserAuthentication", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("reserves a popup and resolves its return URL", async () => {
        vi.useFakeTimers();
        const popup = {
            closed: false,
            location: {
                href: "about:blank",
                assign(url: string) {
                    this.href = url;
                },
            },
            close() {
                this.closed = true;
            },
        };
        vi.stubGlobal("window", {
            open: vi.fn(() => popup),
            setInterval,
            clearInterval,
        });
        const authentication =
            createWebBrowserAuthentication();

        const session = authentication.start({
            redirectUrl:
                "https://app.example/auth/callback",
            presentation: "popup",
        });
        const result = session.open(
            "https://auth.example/authorize"
        );
        popup.location.href =
            "https://app.example/auth/callback?code=code";
        await vi.advanceTimersByTimeAsync(250);

        await expect(result).resolves.toEqual({
            callbackUrl:
                "https://app.example/auth/callback?code=code",
        });
        expect(popup.closed).toBe(true);
    });

    it("rejects the pending operation when closed", async () => {
        vi.useFakeTimers();
        const popup = {
            closed: false,
            location: {
                href: "about:blank",
                assign(url: string) {
                    this.href = url;
                },
            },
            close() {
                this.closed = true;
            },
        };
        vi.stubGlobal("window", {
            open: vi.fn(() => popup),
            setInterval,
            clearInterval,
        });
        const authentication =
            createWebBrowserAuthentication();
        const session = authentication.start({
            redirectUrl:
                "https://app.example/auth/callback",
            presentation: "popup",
        });
        const result = session.open(
            "https://auth.example/authorize"
        );

        await session.close();

        await expect(result).rejects.toBeInstanceOf(
            BrowserAuthenticationCancelledError
        );
    });
});
