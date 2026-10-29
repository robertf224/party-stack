import { createClientCredentialsOAuthClient, createPublicOAuthClient } from "@party-stack/connect";
import { createNodeRuntime } from "@party-stack/node-runtime";
import { Effect, Scope, Exit } from "effect";
import { createSalesforceClient } from "../lib/index.js";

function requiredEnvironmentVariable(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    }
    return value;
}

function normalizeUrl(value) {
    return value.replace(/\/+$/, "");
}

async function resolveSalesforceUserId(loginUrl, accessToken) {
    const response = await fetch(`${loginUrl}/services/oauth2/userinfo`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        throw new Error(`Salesforce userinfo failed (${response.status}): ${await response.text()}`);
    }

    const user = await response.json();
    const userId = user.user_id ?? user.sub;
    if (typeof userId !== "string" || userId.length === 0) {
        throw new Error("Salesforce userinfo did not return user_id or sub.");
    }
    return userId;
}

export async function createLocalSalesforceSession() {
    const clientId = requiredEnvironmentVariable("SALESFORCE_CLIENT_ID");
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET?.trim();
    const instanceUrl = normalizeUrl(requiredEnvironmentVariable("SALESFORCE_INSTANCE_URL"));
    const loginUrl = normalizeUrl(process.env.SALESFORCE_LOGIN_URL?.trim() || instanceUrl);
    const redirectUrl = process.env.SALESFORCE_REDIRECT_URL?.trim() || "http://localhost:1717/oauth/callback";
    const apiVersion = process.env.SALESFORCE_API_VERSION?.trim() || "65.0";

    if (clientSecret) {
        const oauth = createClientCredentialsOAuthClient({
            clientId,
            clientSecret,
            tokenEndpoint: `${loginUrl}/services/oauth2/token`,
            resolveUserId: (accessToken) => resolveSalesforceUserId(loginUrl, accessToken),
        });
        const session = await oauth.getSession();
        return {
            apiVersion,
            client: createSalesforceClient({
                instanceUrl,
                apiVersion,
                tokenProvider: () => oauth.getAccessToken(),
            }),
            instanceUrl,
            session,
            cleanup() {
                return oauth.cleanup();
            },
        };
    }

    // Smoke and demo intentionally share this runtime scope so the browser login
    // completed by either command can be restored by the other.
    const runtimeScope = Effect.runSync(Scope.make());
    const runtime = (
        await Effect.runPromise(Scope.provide(createNodeRuntime("salesforce-smoke", clientId), runtimeScope))
    ).adapter;
    const oauth = await createPublicOAuthClient({
        clientId,
        redirectUrl,
        scopes: ["api", "refresh_token", "openid"],
        authorizationServer: {
            issuer: loginUrl,
            authorizationEndpoint: `${loginUrl}/services/oauth2/authorize`,
            tokenEndpoint: `${loginUrl}/services/oauth2/token`,
            revocationEndpoint: `${loginUrl}/services/oauth2/revoke`,
        },
        runtime,
        resolveUserId: (accessToken) => resolveSalesforceUserId(loginUrl, accessToken),
    });

    try {
        const restored = await oauth.restoreSessions();
        const session = restored[0] ? await oauth.refresh(restored[0].userId) : await oauth.signIn();
        const client = createSalesforceClient({
            instanceUrl,
            apiVersion,
            tokenProvider: () => oauth.getAccessToken(session.userId),
        });

        return {
            apiVersion,
            client,
            instanceUrl,
            session,
            async cleanup() {
                await oauth.cleanup();
                await Effect.runPromise(Scope.close(runtimeScope, Exit.void));
            },
        };
    } catch (error) {
        await oauth.cleanup();
        await Effect.runPromise(Scope.close(runtimeScope, Exit.void));
        throw error;
    }
}
