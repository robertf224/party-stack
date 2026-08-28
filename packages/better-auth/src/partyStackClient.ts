import type { PartyStackPlugin } from "./partyStack.js";
import type { BetterAuthClientPlugin } from "better-auth/client";

export interface PartyStackClient {
    subscribe(listener: () => Promise<void>): () => void;
}

export function partyStackClient() {
    const listeners = new Set<() => Promise<void>>();
    const notifySessionChanged = async () => {
        for (const listener of listeners) {
            await listener();
        }
    };
    const partyStackActions: PartyStackClient = {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        id: "party-stack",
        version: "0.1.0",
        $InferServerPlugin: {} as PartyStackPlugin,
        atomListeners: [
            {
                matcher(path) {
                    return path === "/multi-session/set-active";
                },
                signal: "$sessionSignal",
            },
        ],
        fetchPlugins: [
            {
                id: "party-stack",
                name: "Party Stack",
                hooks: {
                    async onSuccess(context) {
                        const path = new URL(context.request.url).pathname;
                        if (path.endsWith("/multi-session/list-device-sessions")) {
                            return;
                        }
                        await notifySessionChanged();
                    },
                },
            },
        ],
        getActions: () => ({
            partyStack: partyStackActions,
        }),
    } satisfies BetterAuthClientPlugin;
}

export type PartyStackClientPlugin = ReturnType<typeof partyStackClient>;
