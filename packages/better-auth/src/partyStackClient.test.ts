import { describe, expect, it, vi } from "vitest";
import { partyStackClient } from "./partyStackClient.js";

describe("partyStackClient", () => {
    it("awaits subscribers after auth requests", async () => {
        const plugin = partyStackClient();
        expect(plugin.id).toBe("party-stack");
        expect(
            plugin.$InferServerPlugin
        ).toEqual({});
        const actions = plugin.getActions();
        const listener = vi.fn(() =>
            Promise.resolve()
        );
        actions.partyStack.subscribe(
            listener
        );
        const fetchPlugin =
            plugin.fetchPlugins[0]!;

        await fetchPlugin.hooks.onSuccess?.({
            request: new Request(
                "https://app.example/api/auth/sign-in/email"
            ),
        } as never);

        expect(listener).toHaveBeenCalledOnce();

        await fetchPlugin.hooks.onSuccess?.({
            request: new Request(
                "https://app.example/api/auth/multi-session/list-device-sessions"
            ),
        } as never);

        expect(listener).toHaveBeenCalledOnce();
    });
});
