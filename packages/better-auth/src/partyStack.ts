import { createAuthMiddleware } from "better-auth/api";
import { parseCookies, setRequestCookie } from "better-auth/cookies";
import { multiSession, type MultiSessionConfig } from "better-auth/plugins";
import { getPartyStackSessionId } from "./sessionSelection.js";
import type { BetterAuthPlugin } from "better-auth";

export type PartyStackOptions = MultiSessionConfig;
export type PartyStackPlugin = Omit<ReturnType<typeof multiSession>, "id"> & {
    id: "party-stack";
};

export function partyStack(options?: PartyStackOptions): PartyStackPlugin {
    const plugin = multiSession(options);
    const result = {
        ...plugin,
        id: "party-stack",
        hooks: {
            ...plugin.hooks,
            before: [
                {
                    matcher(context) {
                        if (context.path !== "/get-session") {
                            return false;
                        }
                        const headers = context.request?.headers ?? context.headers;
                        return Boolean(headers && getPartyStackSessionId(headers));
                    },
                    handler: createAuthMiddleware(async (context) => {
                        const headers = context.request?.headers ?? context.headers;
                        if (!headers) {
                            return;
                        }
                        const sessionId = getPartyStackSessionId(headers);
                        if (!sessionId) {
                            return;
                        }
                        const selectedHeaders = new Headers(headers);
                        const { sessionToken, sessionData } = context.context.authCookies;
                        setRequestCookie(selectedHeaders, sessionToken.name, "");
                        setRequestCookie(selectedHeaders, sessionData.name, "");
                        const cookies = parseCookies(headers.get("cookie") ?? "");
                        for (const [name, signedToken] of cookies) {
                            if (!name.includes("_multi-")) {
                                continue;
                            }
                            const token = await context.getSignedCookie(name, context.context.secret);
                            if (!token) {
                                continue;
                            }
                            const session = await context.context.internalAdapter.findSession(token);
                            if (
                                session?.session.id !== sessionId ||
                                session.session.expiresAt <= new Date()
                            ) {
                                continue;
                            }
                            setRequestCookie(selectedHeaders, sessionToken.name, signedToken);
                            break;
                        }
                        return {
                            context: {
                                headers: selectedHeaders,
                            },
                        };
                    }),
                },
            ],
        },
    } satisfies BetterAuthPlugin;
    return result as PartyStackPlugin;
}
