import { partyStackClient } from "@party-stack/better-auth";
import { createAuthClient } from "better-auth/client";
import { oauthPopupClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    baseURL: typeof globalThis.location === "undefined" ? undefined : globalThis.location.origin,
    plugins: [oauthPopupClient(), partyStackClient()],
});
