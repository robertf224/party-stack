import { BrowserAuthenticationCancelledError } from "@party-stack/runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
    createWebBrowserAuthentication,
    relayWebBrowserAuthenticationCallback,
} from "./createWebBrowserAuthentication.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("createWebBrowserAuthentication", () => {
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
        const messages = new EventTarget();
        vi.stubGlobal("window", {
            addEventListener: messages.addEventListener.bind(messages),
            removeEventListener: messages.removeEventListener.bind(messages),
            open: vi.fn(() => popup),
            setInterval,
            clearInterval,
        });
        const authentication = createWebBrowserAuthentication();

        const session = authentication.start({
            redirectUrl: "https://app.example/auth/callback",
            presentation: "popup",
        });
        const result = session.open("https://auth.example/authorize");
        popup.location.href = "https://app.example/auth/callback?code=code";
        await vi.advanceTimersByTimeAsync(250);

        await expect(result).resolves.toEqual({
            callbackUrl: "https://app.example/auth/callback?code=code",
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
        const messages = new EventTarget();
        vi.stubGlobal("window", {
            addEventListener: messages.addEventListener.bind(messages),
            removeEventListener: messages.removeEventListener.bind(messages),
            open: vi.fn(() => popup),
            setInterval,
            clearInterval,
        });
        const authentication = createWebBrowserAuthentication();
        const session = authentication.start({
            redirectUrl: "https://app.example/auth/callback",
            presentation: "popup",
        });
        const result = session.open("https://auth.example/authorize");

        await session.close();

        await expect(result).rejects.toBeInstanceOf(BrowserAuthenticationCancelledError);
    });
});

it("accepts a callback message when popup location reads stay blocked, and rejects spoofed responses", async () => {
    vi.useFakeTimers();
    const messages = new EventTarget();
    const popup = {
        closed: false,
        location: {
            assign: vi.fn(),
            get href(): string {
                throw new Error("Cross-origin access");
            },
        },
        close: vi.fn(),
    };
    vi.stubGlobal("window", {
        open: () => popup,
        setInterval,
        clearInterval,
        addEventListener: messages.addEventListener.bind(messages),
        removeEventListener: messages.removeEventListener.bind(messages),
    });
    const session = createWebBrowserAuthentication().start({
        redirectUrl: "https://app.example/auth/callback",
        presentation: "popup",
    });
    const result = session.open("https://auth.example/authorize?state=expected");
    const send = (origin: string, source: unknown, callbackUrl: string) =>
        messages.dispatchEvent(
            Object.assign(new Event("message"), {
                origin,
                source,
                data: { type: "party-stack:browser-authentication:callback", callbackUrl },
            })
        );
    send("https://wrong.example", popup, "https://app.example/auth/callback?code=fixture&state=expected");
    send("https://app.example", {}, "https://app.example/auth/callback?code=fixture&state=expected");
    send("https://app.example", popup, "https://app.example/auth/callback?code=fixture&state=wrong");
    send("https://app.example", popup, "https://app.example/other?code=fixture&state=expected");
    expect(popup.close).not.toHaveBeenCalled();
    send("https://app.example", popup, "https://app.example/auth/callback?code=fixture&state=expected");
    await expect(result).resolves.toEqual({
        callbackUrl: "https://app.example/auth/callback?code=fixture&state=expected",
    });
    expect(popup.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(popup.close).toHaveBeenCalledOnce();
});

it("relays a localhost callback to the explicitly configured worktree and validates the acknowledgment", () => {
    const messages = new EventTarget();
    const opener = { postMessage: vi.fn() };
    const origin = "https://wt-example.issue-tracker.localhost";
    const callbackUrl = "http://localhost:3000/auth/callback?state=expected&code=fixture";
    vi.stubGlobal("window", {
        opener,
        location: { href: callbackUrl, origin: "http://localhost:3000" },
        addEventListener: messages.addEventListener.bind(messages),
        removeEventListener: messages.removeEventListener.bind(messages),
    });
    const accepted = vi.fn();
    const stop = relayWebBrowserAuthenticationCallback(callbackUrl, {
        openerOrigin: origin,
        onAccepted: accepted,
    });
    expect(opener.postMessage).toHaveBeenCalledWith(
        { type: "party-stack:browser-authentication:callback", callbackUrl },
        origin
    );
    const send = (source: unknown, senderOrigin: string, state: string) =>
        messages.dispatchEvent(
            Object.assign(new Event("message"), {
                source,
                origin: senderOrigin,
                data: { type: "party-stack:browser-authentication:accepted", state },
            })
        );
    send(opener, "https://wrong.example", "expected");
    send({}, origin, "expected");
    send(opener, origin, "wrong");
    expect(accepted).not.toHaveBeenCalled();
    send(opener, origin, "expected");
    expect(accepted).toHaveBeenCalledOnce();
    send(opener, origin, "expected");
    expect(accepted).toHaveBeenCalledOnce();
    stop?.();
});
