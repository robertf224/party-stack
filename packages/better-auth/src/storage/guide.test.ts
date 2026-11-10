import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { make as makeTables } from "@party-stack/ontology-storage/memory/tables";
import { betterAuth } from "better-auth";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { authModels, authOntology } from "../examples/auth-ontology.js";
import { partyStack } from "../partyStack.js";
import { makeBetterAuthStorage } from "./index.js";

test("the guide's four auth models store a real sign-up and resolve its cookie session", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "auth-guide",
                    ir: authOntology,
                    tables: yield* makeTables(),
                    mutators: {},
                });
                const database = yield* makeBetterAuthStorage({
                    storage: backend.storage,
                    models: authModels,
                });
                const auth = betterAuth({
                    baseURL: "http://localhost:3000",
                    secret: "party-stack-guide-test-secret-party-stack-guide-test-secret",
                    database,
                    emailAndPassword: { enabled: true },
                    plugins: [partyStack()],
                });
                const response = yield* Effect.promise(() =>
                    auth.handler(
                        new Request("http://localhost:3000/api/auth/sign-up/email", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                                name: "Alice",
                                email: "alice@example.com",
                                password: "test-password",
                            }),
                        })
                    )
                );
                expect(response.status).toBe(200);
                const cookie = response.headers
                    .getSetCookie()
                    .map((value) => value.split(";")[0])
                    .join("; ");
                const session = yield* Effect.promise(() =>
                    auth.api.getSession({ headers: new Headers({ cookie }) })
                );
                expect(session?.user).toMatchObject({ name: "Alice", email: "alice@example.com" });
                for (const objectType of ["AuthUser", "AuthSession", "AuthAccount"]) {
                    expect(yield* backend.storage.read((tx) => tx.loadSubset(objectType))).toHaveLength(1);
                }
            })
        )
    );
});
