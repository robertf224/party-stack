import { makeBetterAuthStorage } from "@party-stack/better-auth/storage";
import { o, type OntologyIR } from "@party-stack/ontology";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { field, ilike } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { betterAuth } from "better-auth";
import { Effect, Stream } from "effect";
import { expect, it } from "vite-plus/test";
import ontology from "../ontology/ontology";
import { serverOntology, authModels } from "./ontology";
import { publicBackend } from "./public-backend";

const object = (name: string, properties: string[]) => ({
    name,
    displayName: name,
    pluralDisplayName: name,
    primaryKey: "id",
    properties: properties.map((name) => ({ name, displayName: name, type: o.string({}) })),
});
const full: OntologyIR = {
    types: [],
    actionTypes: [],
    queryFunctionTypes: [],
    linkTypes: [],
    objectTypes: [object("User", ["id", "givenName", "privateField"]), object("Session", ["id", "token"])],
};
const visible: OntologyIR = { ...full, objectTypes: [object("User", ["id", "givenName"])] };

it("searches canonical profiles and projects snapshots and journal changes before public replication", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const owned = yield* makeOwnedBackend({
                namespace: "public-profile",
                ir: full,
                tables,
                mutators: {},
            });
            const backend = publicBackend(owned, visible);
            const before = yield* backend.loadSubset({ objectType: "User" });
            yield* owned.storage.transaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.put("User", { id: "ada", givenName: "Ada", privateField: "private metadata" });
                    yield* tx.put("User", {
                        id: "grace",
                        givenName: "Grace",
                        privateField: "private metadata",
                    });
                    yield* tx.put("Session", { id: "session", token: "private token" });
                })
            );
            const search = yield* backend.loadSubset({
                objectType: "User",
                query: { where: ilike(field("givenName"), "%gr%") },
            });
            expect(search.rows).toEqual([{ key: "grace", value: { id: "grace", givenName: "Grace" } }]);
            const page = yield* backend.changes!.pull({ cursor: before.cursor });
            expect(page.commits[0]?.changes).toEqual([
                { kind: "put", objectType: "User", key: "ada", value: { id: "ada", givenName: "Ada" } },
                { kind: "put", objectType: "User", key: "grace", value: { id: "grace", givenName: "Grace" } },
            ]);
            expect((yield* Effect.result(backend.loadSubset({ objectType: "Session" })))._tag).toBe(
                "Failure"
            );
            expect(
                (yield* Effect.result(
                    backend.loadSubset({
                        objectType: "User",
                        query: { where: ilike(field("privateField"), "%") },
                    })
                ))._tag
            ).toBe("Failure");
            yield* owned.storage.transaction((tx) => tx.delete("Session", "session"));
            expect((yield* backend.changes!.pull({ cursor: page.cursor })).commits[0]?.changes).toEqual([]);
        })
    );
});

it("publishes real Better Auth sign-up as a public User change while hiding account/session data", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const owned = yield* makeOwnedBackend({
                    namespace: "auth-public-profile",
                    ir: serverOntology,
                    tables,
                    mutators: {},
                });
                const backend = publicBackend(owned, ontology);
                const database = yield* makeBetterAuthStorage({ storage: owned.storage, models: authModels });
                const auth = betterAuth({
                    database,
                    baseURL: "http://localhost:3000",
                    secret: "test-secret-that-is-over-thirty-two-characters",
                    emailAndPassword: { enabled: true, minPasswordLength: 3 },
                    user: {
                        additionalFields: {
                            givenName: { type: "string", required: false },
                            familyName: { type: "string", required: false },
                        },
                    },
                });
                const before = yield* backend.loadSubset({ objectType: "User" });
                const notifications = yield* owned.protocol.subscribeChanges!;
                const signed = yield* Effect.promise(() =>
                    auth.api.signUpEmail({
                        body: {
                            name: "Lin Example",
                            email: "lin@example.com",
                            password: "test-password",
                            givenName: "Lin",
                            familyName: "Example",
                        },
                    })
                );
                yield* Stream.runHead(notifications).pipe(Effect.timeout("1 second"));
                const page = yield* backend.changes!.pull({ cursor: before.cursor });
                const changes = page.commits.flatMap((commit) => commit.changes);
                expect(changes).toEqual([
                    {
                        kind: "put",
                        objectType: "User",
                        key: signed.user.id,
                        value: {
                            id: signed.user.id,
                            givenName: "Lin",
                            familyName: "Example",
                            email: "lin@example.com",
                        },
                    },
                ]);
                const profiles = yield* backend.loadSubset({
                    objectType: "User",
                    query: { where: ilike(field("givenName"), "%lin%") },
                });
                expect(profiles.rows.map((row) => row.value)).toEqual([
                    changes[0]!.kind === "put" ? changes[0]!.value : undefined,
                ]);
                expect(JSON.stringify(page)).not.toMatch(
                    /passwordHash|LoginMethod|Session|emailVerified|displayName/
                );
            })
        )
    );
});
