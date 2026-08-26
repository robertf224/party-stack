import { mkdirSync } from "node:fs";
import { partyStack } from "@party-stack/better-auth";
import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { oauthPopup } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";

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

mkdirSync("temp", { recursive: true });
const database = new Database("temp/issue-tracker-authentication.sqlite");
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

const authOptions = {
    database,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET ?? "party-stack-issue-tracker-development-secret-change-me",
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 3,
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

await (await getMigrations(authOptions)).runMigrations();

export const auth = betterAuth(authOptions);

const findUser = database.prepare(`SELECT "id" FROM "user" WHERE "email" = ?`);
for (const user of issueTrackerUsers) {
    if (findUser.get(user.email)) continue;
    await auth.api.signUpEmail({
        body: {
            email: user.email,
            password: user.password,
            name: user.name,
        },
    });
}
