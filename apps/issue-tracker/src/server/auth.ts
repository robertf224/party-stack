import { partyStack } from "@party-stack/better-auth";
import { eq, field } from "@party-stack/ontology-storage";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { oauthPopup } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Effect } from "effect";
import { serverStorage } from "./storage";

export const issueTrackerUsers = [
    {
        email: "ada@example.com",
        password: "ada",
        name: "Ada Lovelace",
        givenName: "Ada",
        familyName: "Lovelace",
    },
    {
        email: "grace@example.com",
        password: "grace",
        name: "Grace Hopper",
        givenName: "Grace",
        familyName: "Hopper",
    },
] as const;

const { adapter: database, storage } = serverStorage;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

const authOptions = {
    database,
    baseURL:
        (import.meta.env.DEV ? import.meta.env.WORKTREE_DEV_ORIGIN : undefined) ??
        process.env.BETTER_AUTH_URL ??
        "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET ?? "party-stack-issue-tracker-development-secret-change-me",
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 3,
    },
    user: {
        additionalFields: {
            givenName: { type: "string", required: false },
            familyName: { type: "string", required: false },
        },
    },
    socialProviders:
        googleClientId && googleClientSecret
            ? {
                  google: {
                      clientId: googleClientId,
                      clientSecret: googleClientSecret,
                  },
              }
            : {},
    plugins: [
        partyStack({
            maximumSessions: 10,
        }),
        oauthPopup(),
        tanstackStartCookies(),
    ],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);

for (const user of issueTrackerUsers) {
    const existing = await Effect.runPromise(
        storage.read((tx) =>
            tx.loadSubset("User", {
                where: eq(field("email"), user.email),
                limit: 1,
            })
        )
    );
    if (existing.length) continue;
    await auth.api.signUpEmail({
        body: {
            email: user.email,
            password: user.password,
            name: user.name,
            givenName: user.givenName,
            familyName: user.familyName,
        },
    });
}
