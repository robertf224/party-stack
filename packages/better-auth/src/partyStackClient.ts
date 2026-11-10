import { multiSessionClient } from "better-auth/client/plugins";
import type { PartyStackPlugin } from "./partyStack.js";
import type { BetterAuthClientPlugin } from "better-auth/client";

/** Keep Better Auth's native session API and cache invalidation. Saved Connect
 * inventory is observed through ontology queries, not a second event system.
 */
export function partyStackClient() {
    return {
        ...multiSessionClient(),
        id: "party-stack",
        $InferServerPlugin: {} as PartyStackPlugin,
    } satisfies BetterAuthClientPlugin;
}

export type PartyStackClientPlugin = ReturnType<typeof partyStackClient>;
