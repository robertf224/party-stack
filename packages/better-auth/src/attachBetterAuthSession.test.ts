import { expect, test, vi } from "vite-plus/test";
import { attachBetterAuthSession } from "./attachBetterAuthSession.js";

function fixture() {
    const attachExternalSession = vi.fn(async (_instance: string, _session: string) => ({
        kind: "external-session" as const,
        id: "saved-account",
    }));
    const listDeviceSessions = vi.fn(async () => ({
        data: [
            {
                session: { id: "other-user", token: "other-token", expiresAt: new Date(9e12) },
                user: { id: "bob" },
            },
            {
                session: { id: "older-same-user", token: "old-token", expiresAt: new Date(9e12) },
                user: { id: "alice" },
            },
            {
                session: { id: "chosen-session", token: "chosen-token", expiresAt: new Date(9e12) },
                user: { id: "alice" },
            },
        ],
    }));
    return {
        authentication: { attachExternalSession },
        client: { multiSession: { listDeviceSessions, revoke: async () => ({}) } },
        serviceInstanceId: "app",
    };
}

test("attaches the exact token returned by sign-in rather than another session for that user", async () => {
    const f = fixture();
    expect(await attachBetterAuthSession({ ...f, session: { token: "chosen-token" } })).toEqual({
        kind: "external-session",
        id: "saved-account",
    });
    expect(f.client.multiSession.listDeviceSessions).toHaveBeenCalledOnce();
    expect(f.authentication.attachExternalSession).toHaveBeenCalledWith("app", "chosen-session");
});

test("a session object can attach its ID directly; verification remains with the credential owner", async () => {
    const f = fixture();
    await attachBetterAuthSession({ ...f, session: { id: "chosen-session" } });
    expect(f.client.multiSession.listDeviceSessions).not.toHaveBeenCalled();
    expect(f.authentication.attachExternalSession).toHaveBeenCalledWith("app", "chosen-session");
});

test("an unmatched token never falls back to another account or session", async () => {
    const f = fixture();
    await expect(
        attachBetterAuthSession({ ...f, session: { token: "private-missing-token" } })
    ).rejects.toMatchObject({ kind: "NeedsAuthentication" });
    expect(f.authentication.attachExternalSession).not.toHaveBeenCalled();
});

test("temporary list failures do not turn into an authentication failure", async () => {
    const f = fixture();
    const client = {
        multiSession: {
            listDeviceSessions: async () => ({ error: { status: 503, message: "private-details" } }),
            revoke: async () => ({}),
        },
    };
    await expect(
        attachBetterAuthSession({ ...f, client, session: { token: "chosen-token" } })
    ).rejects.toMatchObject({ kind: "Provider", retryable: true });
    expect(f.authentication.attachExternalSession).not.toHaveBeenCalled();
});

test("empty session identifiers fail before any IO", async () => {
    const f = fixture();
    await expect(attachBetterAuthSession({ ...f, session: { token: "" } })).rejects.toMatchObject({
        kind: "Configuration",
    });
    expect(f.client.multiSession.listDeviceSessions).not.toHaveBeenCalled();
    expect(f.authentication.attachExternalSession).not.toHaveBeenCalled();
});
