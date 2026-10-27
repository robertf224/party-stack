import { DatabaseSync } from "node:sqlite";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR, type TypeDef } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Tables } from "@party-stack/ontology-storage/tables";
import * as SQLite from "@party-stack/sql-ontology-storage/sqlite";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { partyStack } from "../partyStack.js";
import { makeBetterAuthStorage } from "./index.js";
import type { AuthModelView } from "./view.js";

const optional = (type: TypeDef) => o.optional({ type });
const str = o.string({});
const timestamp = o.timestamp({});
const object = (name: string, fields: Record<string, TypeDef>, primaryKey = "id") => ({
    name,
    displayName: name,
    pluralDisplayName: name,
    primaryKey,
    properties: Object.entries(fields).map(([name, type]) => ({ name, displayName: name, type })),
});
const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        object(
            "Person",
            {
                personId: str,
                displayName: str,
                contact: o.struct({
                    fields: [
                        { name: "email", displayName: "Email", type: str },
                        { name: "phone", displayName: "Phone", type: optional(str) },
                    ],
                }),
                emailVerified: o.boolean({}),
                avatar: optional(str),
                createdAt: timestamp,
                updatedAt: timestamp,
                labels: optional(o.list({ elementType: str })),
                profile: optional(o.unknown({})),
                department: str,
            },
            "personId"
        ),
        object("LoginSession", {
            id: str,
            userId: o.objectReference({ objectType: "Person" }),
            token: str,
            expiresAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
            ipAddress: optional(str),
            userAgent: optional(str),
        }),
        object("LoginAccount", {
            id: str,
            issuer: str,
            accountId: str,
            providerId: str,
            userId: o.objectReference({ objectType: "Person" }),
            accessToken: optional(str),
            refreshToken: optional(str),
            idToken: optional(str),
            accessTokenExpiresAt: optional(timestamp),
            refreshTokenExpiresAt: optional(timestamp),
            scope: optional(str),
            password: optional(str),
            createdAt: timestamp,
            updatedAt: timestamp,
        }),
        object("LoginVerification", {
            id: str,
            identifier: str,
            value: str,
            expiresAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
        }),
        object("Counter", { id: str, value: o.double({}) }),
        object("Membership", { id: str, owner: str, role: str }),
    ],
};
const models: Record<string, AuthModelView> = {
    user: {
        objectType: "Person",
        defaults: { department: "Engineering" },
        lens: {
            operations: [
                o.LensOp.move({ from: ["personId"], to: ["id"] }),
                o.LensOp.move({ from: ["displayName"], to: ["name"] }),
                o.LensOp.move({ from: ["avatar"], to: ["image"] }),
                o.LensOp.move({ from: ["contact", "email"], to: ["email"] }),
                o.LensOp.select({
                    properties: [
                        "id",
                        "name",
                        "email",
                        "emailVerified",
                        "image",
                        "createdAt",
                        "updatedAt",
                        "labels",
                        "profile",
                    ],
                }),
            ],
        },
    },
    session: { objectType: "LoginSession", lens: { operations: [] } },
    account: { objectType: "LoginAccount", lens: { operations: [] } },
    verification: { objectType: "LoginVerification", lens: { operations: [] } },
    counter: { objectType: "Counter", lens: { operations: [] } },
    membership: { objectType: "Membership", lens: { operations: [] } },
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});
const options = {
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-over-thirty-two-characters",
    emailAndPassword: { enabled: true, minPasswordLength: 3 },
    advanced: { database: { joins: true } },
    user: {
        additionalFields: {
            labels: { type: "string[]", required: false },
            profile: { type: "json", required: false },
        },
    },
    plugins: [
        partyStack(),
        {
            id: "tests",
            schema: {
                counter: { fields: { value: { type: "number" } } },
                membership: {
                    fields: {
                        owner: {
                            type: "string",
                            references: { model: "user", field: "id", onDelete: "cascade" },
                        },
                        role: { type: "string" },
                    },
                    indexes: [{ fields: ["owner", "role"], unique: true }],
                },
            },
        },
    ],
} satisfies BetterAuthOptions;

async function setup(sqlite: boolean, namespace = crypto.randomUUID()) {
    const sql = sqlite ? new DatabaseSync(":memory:") : undefined;
    const layer = sql ? SqlTables.layer().pipe(Layer.provide(SQLite.layer(sql))) : Memory.layer;
    const runtime = ManagedRuntime.make(layer);
    closers.push(async () => {
        await runtime.dispose();
        sql?.close();
    });
    const owner = Effect.runSync(Scope.make());
    closers.push(() => Effect.runPromise(Scope.close(owner, Exit.void)));
    const tables = await runtime.runPromise(Tables);
    const backend = await runtime.runPromise(makeOwnedBackend({ tables, namespace, ir, mutators: {} }));
    const factory = await runtime.runPromise(
        Scope.provide(makeBetterAuthStorage({ storage: backend.storage, models }), owner)
    );
    return { adapter: factory(options), factory, tables, owner, namespace, runtime, backend };
}
const user = (name = "Ada", email = "ada@example.com") => ({
    name,
    email,
    emailVerified: false,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
});

for (const sqlite of [false, true])
    describe(`${sqlite ? "SQLite" : "memory"} auth storage`, () => {
        it("runs real sign-up, sign-in, session lookup and revocation", async () => {
            const { factory } = await setup(sqlite);
            const auth = betterAuth({ ...options, database: factory });
            const signed = await auth.api.signUpEmail({
                body: { name: "Ada", email: "ada@example.com", password: "ada" },
                asResponse: true,
            });
            expect(signed.status).toBe(200);
            const cookie = signed.headers
                .getSetCookie()
                .map((value) => value.split(";")[0])
                .join("; ");
            const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
            expect(session?.user.email).toBe("ada@example.com");
            const signedIn = await auth.api.signInEmail({
                body: { email: "ada@example.com", password: "ada" },
            });
            expect(signedIn.user.id).toBe(session?.user.id);
            await auth.api.signOut({ headers: new Headers({ cookie }) });
            expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
        });

        it("round-trips dates, arrays, JSON and explicit nullable clears through ontology storage", async () => {
            const { adapter } = await setup(sqlite);
            const created = await adapter.create<Record<string, unknown>>({
                model: "user",
                data: { ...user(), labels: ["a", "b"], profile: { nested: { value: true } } },
            });
            expect(created.createdAt).toEqual(user().createdAt);
            expect(created.labels).toEqual(["a", "b"]);
            expect(created.profile).toEqual({ nested: { value: true } });
            await adapter.update({
                model: "user",
                where: [{ field: "id", value: created.id as string }],
                update: { profile: null, image: "avatar.png" },
            });
            const found = await adapter.findOne<Record<string, unknown>>({
                model: "user",
                where: [{ field: "image", value: "avatar.png" }],
            });
            expect(found?.profile == null).toBe(true);
            expect(
                (await adapter.findMany({ model: "user", where: [{ field: "profile", value: null }] })).length
            ).toBe(1);
        });

        it("stores application-owned objects and preserves fields hidden by the auth lens", async () => {
            const { adapter, runtime, backend } = await setup(sqlite);
            const storage = backend.storage;
            const person = "Person";
            const created = await adapter.create<{ id: string }>({ model: "user", data: user() });
            const source = await runtime.runPromise(storage.read((tx) => tx.get(person, created.id)));
            expect(source).toMatchObject({
                personId: created.id,
                displayName: "Ada",
                department: "Engineering",
            });
            await runtime.runPromise(
                storage.transaction((tx) =>
                    tx.put(person, {
                        ...source,
                        department: "Research",
                        contact: { ...(source!.contact as Record<string, unknown>), phone: "123" },
                    })
                )
            );
            await adapter.update({
                model: "user",
                where: [{ field: "id", value: created.id }],
                update: { name: "Ada Lovelace" },
            });
            expect(await runtime.runPromise(storage.read((tx) => tx.get(person, created.id)))).toMatchObject({
                displayName: "Ada Lovelace",
                department: "Research",
                contact: { email: "ada@example.com", phone: "123" },
            });
            expect(
                await adapter.findOne({ model: "user", where: [{ field: "name", value: "Ada Lovelace" }] })
            ).not.toHaveProperty("department");
        });

        it("journals auth transactions as one batch and persists that history across backend reconstruction", async () => {
            const { adapter, backend, runtime, tables, namespace } = await setup(sqlite);
            const before = await runtime.runPromise(backend.loadSubset({ objectType: "Person" }));
            let id = "";
            await adapter.transaction(async (tx) => {
                const row = await tx.create<{ id: string }>({ model: "user", data: user() });
                id = row.id;
                await tx.update({
                    model: "user",
                    where: [{ field: "id", value: id }],
                    update: { name: "Ada Lovelace" },
                });
                await tx.create({ model: "membership", data: { owner: id, role: "admin" } });
            });
            const reopened = await runtime.runPromise(
                makeOwnedBackend({ tables, namespace, ir, mutators: {} })
            );
            const page = await runtime.runPromise(reopened.changes!.pull({ cursor: before.cursor }));
            expect(page.commits).toHaveLength(1);
            expect(page.commits[0]?.operationId).toBeUndefined();
            expect(page.commits[0]?.changes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: "put",
                        objectType: "Person",
                        key: id,
                        value: expect.objectContaining({
                            displayName: "Ada Lovelace",
                            department: "Engineering",
                        }),
                    }),
                    expect.objectContaining({ kind: "put", objectType: "Membership" }),
                ])
            );
            expect(page.commits[0]?.changes).toHaveLength(2);
            await adapter.delete({ model: "user", where: [{ field: "id", value: id }] });
            const deleted = await runtime.runPromise(backend.changes!.pull({ cursor: page.cursor }));
            expect(deleted.commits).toHaveLength(1);
            expect(deleted.commits[0]?.changes).toEqual(
                expect.arrayContaining([
                    { kind: "delete", objectType: "Person", key: id },
                    expect.objectContaining({ kind: "delete", objectType: "Membership" }),
                ])
            );
        });

        it("rolls back every callback write and rejects a transaction handle used after settlement", async () => {
            const { adapter, backend, runtime } = await setup(sqlite);
            const before = await runtime.runPromise(backend.loadSubset({ objectType: "Person" }));
            let transaction!: Parameters<Parameters<typeof adapter.transaction>[0]>[0];
            const marker = new Error("rollback fixture");
            await expect(
                adapter.transaction(async (tx) => {
                    transaction = tx;
                    await tx.create({ model: "user", data: user() });
                    await tx.create({ model: "counter", data: { value: 5 } });
                    expect(await tx.count({ model: "user" })).toBe(1);
                    throw marker;
                })
            ).rejects.toBe(marker);
            expect(await adapter.count({ model: "user" })).toBe(0);
            expect(await adapter.count({ model: "counter" })).toBe(0);
            expect(
                (await runtime.runPromise(backend.changes!.pull({ cursor: before.cursor }))).commits
            ).toEqual([]);
            await expect(transaction.create({ model: "counter", data: { value: 9 } })).rejects.toThrow(
                "expired transaction"
            );
        });

        it("commits transactional writes and permits parallel operations on the bound transaction", async () => {
            const { adapter } = await setup(sqlite);
            await adapter.transaction(async (tx) => {
                await Promise.all([
                    tx.create({ model: "counter", data: { value: 1 } }),
                    tx.create({ model: "counter", data: { value: 2 } }),
                ]);
            });
            expect(await adapter.count({ model: "counter" })).toBe(2);
        });

        it("enforces unique constraints and cannot overwrite an existing primary key", async () => {
            const { adapter } = await setup(sqlite);
            await adapter.create({ model: "user", data: { ...user(), id: "same" }, forceAllowId: true });
            await expect(adapter.create({ model: "user", data: user("Duplicate") })).rejects.toThrow(
                "Authentication storage"
            );
            await expect(
                adapter.create({
                    model: "user",
                    data: { ...user("Other", "other@example.com"), id: "same" },
                    forceAllowId: true,
                })
            ).rejects.toThrow("Authentication storage");
            expect(await adapter.count({ model: "user" })).toBe(1);
        });

        it("enforces compound uniqueness and cascades indexed references", async () => {
            const { adapter } = await setup(sqlite);
            const parent = await adapter.create<{ id: string }>({ model: "user", data: user() });
            await adapter.create({ model: "membership", data: { owner: parent.id, role: "admin" } });
            await expect(
                adapter.create({ model: "membership", data: { owner: parent.id, role: "admin" } })
            ).rejects.toThrow("Authentication storage");
            await expect(
                adapter.create({ model: "membership", data: { owner: "missing", role: "viewer" } })
            ).rejects.toThrow("Authentication storage");
            await adapter.delete({ model: "user", where: [{ field: "id", value: parent.id }] });
            expect(await adapter.count({ model: "membership" })).toBe(0);
        });

        it("consumes a one-time credential exactly once across competing adapter instances", async () => {
            const { adapter, factory } = await setup(sqlite);
            await adapter.create({
                model: "verification",
                data: {
                    identifier: "test-code",
                    value: "secret",
                    expiresAt: new Date(Date.now() + 60_000),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            });
            const second = factory(options);
            const results = await Promise.all(
                Array.from({ length: 8 }, (_, i) =>
                    (i % 2 ? second : adapter).consumeOne({
                        model: "verification",
                        where: [{ field: "identifier", value: "test-code" }],
                    })
                )
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await adapter.count({ model: "verification" })).toBe(0);
        });

        it("guards counters atomically under contention", async () => {
            const { adapter, factory } = await setup(sqlite);
            const counter = await adapter.create<{ id: string }>({ model: "counter", data: { value: 3 } });
            const second = factory(options);
            const results = await Promise.all(
                Array.from({ length: 8 }, (_, i) =>
                    (i % 2 ? adapter : second).incrementOne<{ value: number }>({
                        model: "counter",
                        where: [
                            { field: "id", value: counter.id },
                            { field: "value", operator: "gt", value: 0 },
                        ],
                        increment: { value: -1 },
                    })
                )
            );
            expect(results.filter(Boolean)).toHaveLength(3);
            expect(
                await adapter.findOne({ model: "counter", where: [{ field: "id", value: counter.id }] })
            ).toMatchObject({ value: 0 });
        });

        it("rechecks literal wildcard characters before pagination and handles AND/OR predicates", async () => {
            const { adapter } = await setup(sqlite);
            await adapter.create({ model: "user", data: user("Axx", "xx@example.com") });
            await adapter.create({ model: "user", data: user("A_%", "literal@example.com") });
            await adapter.create({ model: "user", data: user("Other", "other@example.com") });
            expect(
                await adapter.findMany({
                    model: "user",
                    where: [{ field: "name", operator: "contains", value: "_%", mode: "insensitive" }],
                    limit: 1,
                })
            ).toMatchObject([{ name: "A_%" }]);
            expect(
                await adapter.findMany({
                    model: "user",
                    where: [
                        { field: "emailVerified", value: false },
                        { field: "name", value: "axx", mode: "insensitive", connector: "OR" },
                        { field: "name", value: "a_%", mode: "insensitive", connector: "OR" },
                    ],
                    sortBy: { field: "name", direction: "desc" },
                })
            ).toHaveLength(2);
        });

        it("supports custom model/field names and scoped joins", async () => {
            const { factory } = await setup(sqlite);
            const adapter = factory({
                ...options,
                user: { ...options.user, modelName: "people", fields: { email: "email_address" } },
            });
            const parent = await adapter.create<{ id: string; email: string }>({
                model: "user",
                data: user(),
            });
            await adapter.create({ model: "membership", data: { owner: parent.id, role: "admin" } });
            const joined = await adapter.findOne<{ email: string; membership: unknown[] }>({
                model: "user",
                where: [{ field: "email", value: "ada@example.com" }],
                join: { membership: { limit: 2 } },
            });
            expect(joined?.email).toBe("ada@example.com");
            expect(joined?.membership).toMatchObject([{ role: "admin" }]);
        });

        it("rejects schema changes in an existing namespace and rejects operations after scope closure", async () => {
            const { adapter, factory, runtime, owner } = await setup(sqlite);
            await adapter.create({ model: "user", data: user() });
            expect(() =>
                factory({
                    ...options,
                    user: { additionalFields: { changed: { type: "string", required: false } } },
                })
            ).toThrow('does not expose "changed"');
            expect(await adapter.count({ model: "user" })).toBe(1);
            await runtime.runPromise(Scope.close(owner, Exit.void));
            await expect(adapter.findMany({ model: "user" })).rejects.toThrow("closed");
        });
    });
