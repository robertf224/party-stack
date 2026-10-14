import { partyStackClient } from "@party-stack/better-auth";
import { createAuthClient } from "better-auth/client";
import { oauthPopupClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    plugins: [oauthPopupClient(), partyStackClient()],
});
