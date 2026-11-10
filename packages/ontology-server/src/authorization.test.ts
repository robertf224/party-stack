import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import {
    context,
    contains,
    eq as expressionEq,
    field as expressionField,
    input,
    literal,
    lookup,
    selectField,
    sub,
} from "@party-stack/ontology-spec/query";
import { eq, field, evaluateQuery } from "@party-stack/ontology-storage";
import { collectByteBlob, type ByteInput } from "@party-stack/ontology-storage/blobs";
import { Effect, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { projectOntologyBackend } from "./authorization.js";
import type { ActionRequest, OntologyBackendService } from "@party-stack/ontology-backend";
import type { attachment } from "@party-stack/ontology-spec/values";

test("action checks look up typed project references without exposing administrator lists", async () => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        context: {
            type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }),
        },
        objectTypes: [
            {
                name: "Project",
                displayName: "Project",
                pluralDisplayName: "Projects",
                primaryKey: "id",
                properties: [
                    { name: "id", displayName: "ID", type: o.string({}) },
                    {
                        name: "adminIds",
                        displayName: "Administrators",
                        type: o.list({ elementType: o.string({}) }),
                    },
                ],
            },
        ],
        actionTypes: [
            {
                name: "createForm",
                displayName: "Create form",
                parameters: [
                    {
                        name: "project",
                        displayName: "Project",
                        type: o.objectReference({ objectType: "Project" }),
                    },
                ],
                logic: [],
            },
        ],
        policy: {
            objects: {
                select: [
                    sub("projects", {
                        from: { source: { objectType: "Project" }, binding: "p" },
                        select: [selectField("id", expressionField("p", "id"))],
                    }),
                ],
            },
            actions: [
                {
                    actionType: "createForm",
                    check: contains(
                        o.Expression.getAt({ source: lookup(input("project")), path: ["adminIds"] }),
                        context("user")
                    ),
                },
            ],
        },
    };
    const applyAction = vi.fn((request: ActionRequest) =>
        Effect.succeed({
            operationId: request.id,
            outcome: "committed" as const,
            affected: [],
        })
    );
    const backend = makeOntologyBackend({
        ir,
        name: "test",
        sourceId: "projects",
        supportsIdempotency: false,
        queryFunction: () => Effect.void,
        applyAction,
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                Effect.succeed({
                    complete: true,
                    rows: evaluateQuery(
                        [
                            { key: "allowed", value: { id: "allowed", adminIds: ["alice"] } },
                            { key: "other", value: { id: "other", adminIds: ["bob"] } },
                        ],
                        subset.query ?? {}
                    ),
                })
            ),
    });
    const view = await Effect.runPromise(projectOntologyBackend({ backend, ir, context: { user: "alice" } }));
    expect(view.ir.objectTypes[0]?.properties.map((p) => p.name)).toEqual(["id"]);
    expect((await Effect.runPromise(view.backend.loadSubset(objectSubset("Project")))).rows).toEqual([
        { key: "allowed", value: { id: "allowed" } },
        { key: "other", value: { id: "other" } },
    ]);
    await Effect.runPromise(
        view.backend.applyAction({
            id: "allowed",
            name: "createForm",
            parameters: { project: "allowed" },
        })
    );
    for (const [project, kind] of [
        ["other", "NotFound"],
        ["missing", "ValidationFailed"],
    ] as const) {
        await expect(
            Effect.runPromise(
                view.backend.applyAction({
                    id: project,
                    name: "createForm",
                    parameters: { project },
                })
            )
        ).rejects.toMatchObject({ kind, actionOutcome: "not-committed" });
    }
    expect(applyAction).toHaveBeenCalledOnce();
});

const watchIR: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    context: { type: o.struct({ fields: [] }) },
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
    policy: {
        objects: {
            select: [
                sub("items", {
                    from: { source: { objectType: "Item" }, binding: "item" },
                    select: [selectField("id", expressionField("item", "id"))],
                }),
            ],
        },
    },
};

test("projection preserves unsupported subset watches and provider polling defaults", async () => {
    const ir = watchIR;
    const { backend } = await Effect.runPromise(
        projectOntologyBackend({
            ir,
            context: {},
            backend: makeOntologyBackend({
                ir,
                name: "test",
                sourceId: "test",
                supportsIdempotency: false,
                loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                applyAction: () => Effect.die("Unexpected action"),
                queryFunction: () => Effect.void,
                watchSubset: () => undefined,
                refresh: () => ({ pollIntervalMs: 60_000 }),
            }),
        })
    );
    expect(backend.watchSubset!(objectSubset("Item"))).toBeUndefined();
    expect(backend.refresh!(objectSubset("Item"))).toEqual({ pollIntervalMs: 60_000 });
});

test.each(["watchSubset", "changes"] as const)(
    "projected %s watches sanitize late provider failures without hiding stream termination",
    async (origin) => {
        for (const kind of ["Unauthenticated", "Forbidden"] as const) {
            const failure = new BackendError({
                operation: "provider.watch",
                kind,
                message: "private upstream user and token",
                retryable: true,
                retryAfterMs: 4321,
                actionOutcome: "unknown",
                cause: new Error("private provider endpoint"),
            });
            const watched = Stream.concat(Stream.make(undefined), Stream.fail(failure));
            const { backend } = await Effect.runPromise(
                projectOntologyBackend({
                    ir: watchIR,
                    context: {},
                    backend: makeOntologyBackend({
                        ir: watchIR,
                        name: "test",
                        sourceId: "test",
                        supportsIdempotency: false,
                        loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        ...(origin === "watchSubset"
                            ? { watchSubset: () => Effect.succeed(watched) }
                            : {
                                  changes: {
                                      watch: Effect.succeed(watched),
                                      pull: () => Effect.die("Unexpected raw journal"),
                                  },
                              }),
                    }),
                })
            );
            let hints = 0;
            const result = await Effect.runPromise(
                Effect.scoped(
                    Effect.result(
                        Stream.runForEach(Stream.unwrap(backend.watchSubset!(objectSubset("Item"))!), () =>
                            Effect.sync(() => {
                                hints++;
                            })
                        )
                    )
                )
            );
            expect(hints).toBe(1);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
                expect(result.failure.kind).toBe(kind === "Unauthenticated" ? "Unavailable" : "NotFound");
                expect(result.failure.message).toBe(
                    kind === "Unauthenticated"
                        ? "The operation could not be completed."
                        : "Resource not found."
                );
                expect(result.failure.cause).toBeUndefined();
            }
            if (kind === "Unauthenticated")
                expect(result).toMatchObject({
                    failure: { retryable: true, retryAfterMs: 4321, actionOutcome: "unknown" },
                });
            expect(backend.changes).toBeUndefined();
            expect(backend.subscribeSelection).toBeUndefined();
        }
    }
);

test("attachment reads re-find the handle in an authorized source row and declared property", async () => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: [
                    { name: "id", displayName: "ID", type: o.string({}) },
                    { name: "owner", displayName: "Owner", type: o.string({}) },
                    { name: "files", displayName: "Files", type: o.list({ elementType: o.attachment({}) }) },
                    { name: "private", displayName: "Private", type: o.attachment({}) },
                    { name: "title", displayName: "Title", type: o.string({}) },
                ],
            },
        ],
    };
    let files = [{ id: "visible-file" }];
    let failRead = false;
    const read = vi.fn(() =>
        Effect.succeed<ByteInput>(
            failRead
                ? { type: "text/plain", stream: Stream.fail(new Error("private-download-url")) }
                : new Blob(["allowed"])
        )
    );
    const metadata = vi.fn(() => Effect.succeed({ size: 7, type: "text/plain" }));
    const stage = vi.fn(() => Effect.die("Staging is not granted by row visibility"));
    const backend: OntologyBackendService = makeOntologyBackend({
        ir,
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        applyAction: () => Effect.die("Unexpected action"),
        queryFunction: () => Effect.void,
        attachments: { read, metadata, stage },
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                Effect.succeed({
                    complete: true,
                    rows: evaluateQuery(
                        [
                            {
                                key: "hidden",
                                value: { id: "hidden", owner: "bob", files: [{ id: "hidden-file" }] },
                            },
                            {
                                key: "visible",
                                value: {
                                    id: "visible",
                                    owner: "alice",
                                    files,
                                    private: { id: "secret" },
                                    title: "visible-file",
                                },
                            },
                        ],
                        subset.query ?? {}
                    ),
                })
            ),
    });
    ir.context = { type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }) };
    ir.policy = {
        objects: {
            select: [
                sub("items", {
                    from: { source: { objectType: "Item" }, binding: "item" },
                    where: expressionEq(expressionField("item", "owner"), context("user")),
                    select: ["id", "owner", "files", "title"].map((name) =>
                        selectField(name, expressionField("item", name))
                    ),
                }),
            ],
        },
    };
    const projected = (
        await Effect.runPromise(projectOntologyBackend({ backend, ir, context: { user: "alice" } }))
    ).backend;
    const visible: attachment = {
        id: "visible-file",
        source: { objectType: "Item", primaryKey: "visible", property: "files" },
    };
    expect(projected.attachments?.stage).toBeUndefined();
    expect(
        await Effect.runPromise(
            Effect.scoped(projected.attachments!.read(visible).pipe(Effect.flatMap(collectByteBlob)))
        ).then((blob) => blob.text())
    ).toBe("allowed");
    expect(await Effect.runPromise(projected.attachments!.metadata(visible))).toEqual({
        size: 7,
        type: "text/plain",
    });
    failRead = true;
    const failedRead = await Effect.runPromise(
        Effect.scoped(
            Effect.result(projected.attachments!.read(visible).pipe(Effect.flatMap(collectByteBlob)))
        )
    );
    expect(failedRead._tag).toBe("Failure");
    if (failedRead._tag === "Failure") {
        expect((failedRead.failure as BackendError).message).toBe("The operation could not be completed.");
        expect((failedRead.failure as BackendError).cause).toBeUndefined();
    }
    failRead = false;
    const forged: attachment[] = [
        { id: "visible-file" },
        { ...visible, id: "unrelated-file" },
        { id: "hidden-file", source: { ...visible.source!, primaryKey: "hidden" } },
        { id: "secret", source: { ...visible.source!, property: "private" } },
        { ...visible, source: { ...visible.source!, property: "title" } },
        { ...visible, source: { ...visible.source!, primaryKey: "missing" } },
        { ...visible, source: { ...visible.source!, objectType: "Private" } },
    ];
    for (const value of forged) {
        await expect(
            Effect.runPromise(Effect.scoped(projected.attachments!.read(value)))
        ).rejects.toMatchObject({
            kind: "NotFound",
        });
        await expect(Effect.runPromise(projected.attachments!.metadata(value))).rejects.toMatchObject({
            kind: "NotFound",
        });
    }
    files = [];
    await expect(
        Effect.runPromise(Effect.scoped(projected.attachments!.read(visible)))
    ).rejects.toMatchObject({
        kind: "NotFound",
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(metadata).toHaveBeenCalledOnce();
    expect(stage).not.toHaveBeenCalled();
});

test("projection filters rows before limits, blocks hidden-field probes, and owns fixed parameters", async () => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        actionTypes: [
            {
                name: "save",
                displayName: "Save",
                logic: [],
                parameters: [
                    { name: "id", displayName: "ID", type: o.string({}) },
                    { name: "owner", displayName: "Owner", type: o.string({}) },
                ],
            },
        ],
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: ["id", "owner", "private"].map((name) => ({
                    name,
                    displayName: name,
                    type: o.string({}),
                })),
            },
        ],
    };
    let applied: ActionRequest | undefined;
    const backend: OntologyBackendService = makeOntologyBackend({
        ir,
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                Effect.succeed({
                    rows: evaluateQuery(
                        [
                            { key: "hidden", value: { id: "hidden", owner: "bob", private: "secret" } },
                            { key: "visible", value: { id: "visible", owner: "alice", private: "secret" } },
                        ],
                        subset.query ?? {}
                    ),
                    complete: true,
                })
            ),
        applyAction: (invocation) =>
            Effect.sync(() => {
                applied = invocation;
                return {
                    operationId: invocation.id,
                    outcome: "committed" as const,
                    affected: [{ objectType: "Private", keys: ["secret"] }],
                };
            }),
        queryFunction: () => Effect.succeed(undefined),
    });
    ir.context = { type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }) };
    ir.policy = {
        objects: {
            select: [
                sub("items", {
                    from: { source: { objectType: "Item" }, binding: "item" },
                    where: expressionEq(expressionField("item", "owner"), context("user")),
                    select: ["id", "owner"].map((name) => selectField(name, expressionField("item", name))),
                }),
            ],
        },
        actions: [
            {
                actionType: "save",
                bind: [{ parameter: "owner", expression: context("user") }],
                check: expressionEq(input("owner"), context("user")),
            },
        ],
    };
    const view = await Effect.runPromise(
        projectOntologyBackend({
            backend,
            ir,
            context: { user: "alice" },
        })
    );
    expect(view.context).toEqual({ user: "alice" });
    expect(view.ir.actionTypes[0]?.parameters.map((parameter) => parameter.name)).toEqual(["id"]);
    await Effect.runPromise(
        Effect.gen(function* () {
            expect((yield* view.backend.loadSubset(objectSubset("Item", { limit: 1 }))).rows).toEqual([
                { key: "visible", value: { id: "visible", owner: "alice" } },
            ]);
            const hiddenProbe = yield* view.backend
                .loadSubset(objectSubset("Item", { where: eq(field("private"), "secret") }))
                .pipe(Effect.flip);
            expect(hiddenProbe.kind).toBe("NotFound");
            expect(hiddenProbe.issues).toBeUndefined();
            expect(hiddenProbe.cause).toBeUndefined();
            const receipt = yield* view.backend.applyAction({
                id: "one",
                name: "save",
                parameters: { id: "visible", owner: "bob" },
            });
            expect(applied?.parameters.owner).toBe("alice");
            expect(JSON.stringify(receipt)).not.toMatch(/Private|secret/);
        })
    );
});

test("parameter resolution uses projected defaults and authorized row/property reads without invoking", async () => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: ["id", "owner", "private"].map((name) => ({
                    name,
                    displayName: name,
                    type: o.string({}),
                })),
            },
        ],
        actionTypes: [
            {
                name: "edit",
                displayName: "Edit",
                logic: [],
                parameters: [
                    { name: "item", displayName: "Item", type: o.objectReference({ objectType: "Item" }) },
                    { name: "owner", displayName: "Owner", type: o.string({}) },
                    {
                        name: "title",
                        displayName: "Title",
                        type: o.string({}),
                        defaultValue: o.Expression.getAt({
                            source: o.Expression.lookup({
                                reference: o.Expression.inputReference({ name: "item" }),
                            }),
                            path: ["owner"],
                        }),
                    },
                    {
                        name: "privateCopy",
                        displayName: "Private",
                        type: o.optional({ type: o.string({}) }),
                        defaultValue: o.Expression.getAt({
                            source: o.Expression.lookup({
                                reference: o.Expression.inputReference({ name: "item" }),
                            }),
                            path: ["private"],
                        }),
                    },
                    {
                        name: "ownerCopy",
                        displayName: "Owner copy",
                        type: o.string({}),
                        defaultValue: o.Expression.inputReference({ name: "owner" }),
                    },
                ],
            },
        ],
    };
    let invoked = false;
    const backend: OntologyBackendService = makeOntologyBackend({
        ir,
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                Effect.succeed({
                    complete: true,
                    rows: evaluateQuery(
                        [
                            {
                                key: "visible",
                                value: { id: "visible", owner: "alice", private: "never-disclose" },
                            },
                            {
                                key: "hidden",
                                value: { id: "hidden", owner: "bob", private: "never-disclose" },
                            },
                        ],
                        subset.query ?? {}
                    ),
                })
            ),
        applyAction: (invocation) =>
            Effect.sync(() => {
                invoked = true;
                return { operationId: invocation.id, outcome: "committed" as const };
            }),
        queryFunction: () => Effect.void,
    });
    ir.policy = {
        objects: {
            select: [
                sub("items", {
                    from: { source: { objectType: "Item" }, binding: "item" },
                    where: expressionEq(expressionField("item", "owner"), literal("alice")),
                    select: ["id", "owner"].map((name) => selectField(name, expressionField("item", name))),
                }),
            ],
        },
        actions: [
            {
                actionType: "edit",
                bind: [{ parameter: "owner", expression: literal("fixed-owner") }],
                check: literal(true),
            },
        ],
    };
    const view = await Effect.runPromise(projectOntologyBackend({ backend, ir, context: {} }));
    const result = await Effect.runPromise(
        view.backend.resolveActionParameters!("edit", { item: "visible", owner: "tampered" })
    );
    expect(result).toMatchObject({ item: "visible", title: "alice", ownerCopy: "fixed-owner" });
    expect(result).not.toHaveProperty("owner");
    expect(result.privateCopy).toBeUndefined();
    const hidden = await Effect.runPromise(
        Effect.result(view.backend.resolveActionParameters!("edit", { item: "hidden" }))
    );
    expect(JSON.stringify(hidden)).not.toMatch(/bob|never-disclose/);
    expect(invoked).toBe(false);
});

test.each([
    { name: "readable keys", keys: ["visible"], expected: ["visible"] },
    { name: "hidden keys", keys: ["hidden"] },
    { name: "mixed visibility", keys: ["visible", "hidden"] },
    { name: "deleted keys", keys: ["deleted"] },
    { name: "failed visibility proof", keys: ["visible"], failure: "error" },
    { name: "incomplete visibility proof", keys: ["visible"], failure: "incomplete" },
    { name: "empty affected set", keys: [], expected: [] },
])("receipt projection preserves safe read-back targets: $name", async ({ keys, expected, failure }) => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        queryFunctionTypes: [],
        context: { type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }) },
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: ["id", "owner"].map((name) => ({ name, displayName: name, type: o.string({}) })),
            },
        ],
        actionTypes: [{ name: "touch", displayName: "Touch", parameters: [], logic: [] }],
        policy: {
            objects: {
                select: [
                    sub("items", {
                        from: { source: { objectType: "Item" }, binding: "item" },
                        where: expressionEq(expressionField("item", "owner"), context("user")),
                        select: [selectField("id", expressionField("item", "id"))],
                    }),
                ],
            },
            actions: [{ actionType: "touch", check: literal(true) }],
        },
    };
    let committed = false;
    let calls = 0;
    const backend = makeOntologyBackend({
        ir,
        name: "receipt",
        sourceId: "receipt",
        supportsIdempotency: true,
        queryFunction: () => Effect.void,
        applyAction: (request) =>
            Effect.sync(() => {
                committed = true;
                calls++;
                return {
                    operationId: request.id,
                    outcome: "committed" as const,
                    affected: [{ objectType: "Item", keys }],
                    affectedComplete: true,
                    cursor: "private-journal-position",
                };
            }),
        loadSubset: (request) =>
            Effect.gen(function* () {
                if (committed && failure === "error")
                    return yield* new BackendError({
                        operation: "loadSubset",
                        kind: "Unavailable",
                        retryable: true,
                        message: "Read unavailable",
                    });
                const subset = yield* compileObjectSubset(ir, request);
                return {
                    complete: !(committed && failure === "incomplete"),
                    rows: evaluateQuery(
                        [
                            { key: "visible", value: { id: "visible", owner: "alice" } },
                            { key: "hidden", value: { id: "hidden", owner: "bob" } },
                        ],
                        subset.query ?? {}
                    ),
                };
            }),
    });
    const view = await Effect.runPromise(projectOntologyBackend({ backend, ir, context: { user: "alice" } }));
    const receipt = await Effect.runPromise(
        view.backend.applyAction({ id: "op", name: "touch", parameters: {} })
    );
    expect(receipt.affected).toEqual([{ objectType: "Item", ...(expected ? { keys: expected } : {}) }]);
    expect(receipt.affectedComplete).toBe(true);
    expect(receipt.outcome).toBe("committed");
    expect(receipt.cursor).toBeUndefined();
    expect(calls).toBe(1);
});

test.each([
    {
        name: "unrestricted identities, including a deleted object",
        where: undefined,
        keys: ["deleted"],
        reads: 0,
        exposed: true,
    },
    {
        name: "the context-authorized primary key",
        where: expressionEq(expressionField("item", "id"), context("user")),
        keys: ["alice"],
        reads: 0,
        exposed: true,
    },
    {
        name: "an identity outside the context grant",
        where: expressionEq(expressionField("item", "id"), context("user")),
        keys: ["bob"],
        reads: 1,
        exposed: false,
    },
    {
        name: "a non-key property still needs a read",
        where: expressionEq(expressionField("item", "owner"), context("user")),
        keys: ["alice"],
        reads: 1,
        exposed: true,
    },
])("receipt identity proof: $name", async ({ where, keys, reads, exposed }) => {
    const ir: OntologyIR = {
        ...watchIR,
        context: { type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }) },
        objectTypes: [
            {
                ...watchIR.objectTypes[0]!,
                properties: ["id", "owner"].map((name) => ({ name, displayName: name, type: o.string({}) })),
            },
        ],
        actionTypes: [
            { name: "touch", displayName: "Touch", parameters: [], logic: [], returnType: o.string({}) },
        ],
        queryFunctionTypes: [
            { name: "summary", displayName: "Summary", parameters: [], returnType: o.string({}) },
        ],
        policy: {
            objects: {
                select: [
                    sub("items", {
                        from: { source: { objectType: "Item" }, binding: "item" },
                        where,
                        select: [selectField("id", expressionField("item", "id"))],
                    }),
                ],
            },
            actions: [{ actionType: "touch", check: literal(true) }],
            queryFunctions: [{ queryFunctionType: "summary", check: literal(true) }],
        },
    };
    const loads = vi.fn((request: Parameters<OntologyBackendService["loadSubset"]>[0]) =>
        Effect.gen(function* () {
            const subset = yield* compileObjectSubset(ir, request);
            return {
                complete: true,
                rows: evaluateQuery(
                    [{ key: "alice", value: { id: "alice", owner: "alice" } }],
                    subset.query ?? {}
                ),
            };
        })
    );
    const backend = makeOntologyBackend({
        ir,
        name: "receipt-proof",
        sourceId: "receipt-proof",
        supportsIdempotency: true,
        loadSubset: loads,
        queryFunction: () => Effect.succeed("Public summary computed from private data"),
        applyAction: (request) =>
            Effect.succeed({
                operationId: request.id,
                outcome: "committed",
                result: "Public confirmation",
                affected: [{ objectType: "Item", keys }],
            }),
    });
    const view = await Effect.runPromise(projectOntologyBackend({ backend, ir, context: { user: "alice" } }));
    loads.mockClear();
    const receipt = await Effect.runPromise(
        view.backend.applyAction({ id: "touch", name: "touch", parameters: {} })
    );
    expect(receipt.affected).toEqual([{ objectType: "Item", ...(exposed ? { keys } : {}) }]);
    expect(loads).toHaveBeenCalledTimes(reads);
    expect(receipt.result).toBe("Public confirmation");
    expect(await Effect.runPromise(view.backend.queryFunction("summary", {}))).toBe(
        "Public summary computed from private data"
    );
});
