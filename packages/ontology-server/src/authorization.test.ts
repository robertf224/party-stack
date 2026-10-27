import { o, type OntologyIR } from "@party-stack/ontology";
import { eq, field, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { projectOntologyBackend } from "./authorization.js";
import type { ActionRequest, OntologyBackendService } from "@party-stack/ontology-backend";
import type { attachment } from "@party-stack/ontology/values";

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
    const read = vi.fn(() => Effect.succeed(new Blob(["allowed"])));
    const metadata = vi.fn(() => Effect.succeed({ size: 7, type: "text/plain" }));
    const stage = vi.fn(() => Effect.die("Staging is not granted by row visibility"));
    const backend: OntologyBackendService = {
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        applyAction: () => Effect.die("Unexpected action"),
        queryFunction: () => Effect.void,
        attachments: { read, metadata, stage },
        loadSubset: (subset) =>
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
            }),
    };
    const projected = projectOntologyBackend({
        backend,
        ir,
        context: { user: "alice" },
        policy: {
            allowedObjectTypeProperties: { Item: ["id", "owner", "files", "title"] },
            baseObjectTypeQueries: { Item: ({ ctx }) => eq(field("owner"), ctx.user) },
        },
    }).backend;
    const visible: attachment = {
        id: "visible-file",
        source: { objectType: "Item", primaryKey: "visible", property: "files" },
    };
    expect(projected.attachments?.stage).toBeUndefined();
    expect(await Effect.runPromise(projected.attachments!.read(visible)).then((blob) => blob.text())).toBe(
        "allowed"
    );
    expect(await Effect.runPromise(projected.attachments!.metadata(visible))).toEqual({
        size: 7,
        type: "text/plain",
    });
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
        await expect(Effect.runPromise(projected.attachments!.read(value))).rejects.toMatchObject({
            kind: "NotFound",
        });
        await expect(Effect.runPromise(projected.attachments!.metadata(value))).rejects.toMatchObject({
            kind: "NotFound",
        });
    }
    files = [];
    await expect(Effect.runPromise(projected.attachments!.read(visible))).rejects.toMatchObject({
        kind: "NotFound",
    });
    expect(read).toHaveBeenCalledOnce();
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
    const backend: OntologyBackendService = {
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        loadSubset: (subset) =>
            Effect.succeed({
                rows: evaluateQuery(
                    [
                        { key: "hidden", value: { id: "hidden", owner: "bob", private: "secret" } },
                        { key: "visible", value: { id: "visible", owner: "alice", private: "secret" } },
                    ],
                    subset.query ?? {}
                ),
                complete: true,
            }),
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
    };
    const view = projectOntologyBackend({
        backend,
        ir,
        context: { user: "alice", secret: "private" },
        policy: {
            allowedObjectTypeProperties: { Item: ["id", "owner"] },
            baseObjectTypeQueries: {
                Item: ({ ctx, objectType }) => {
                    expect(objectType).toBe("Item");
                    return eq(field("owner"), ctx.user);
                },
            },
            clientContext: (context) => ({ user: context.user }),
            fixedActionParameterValues: {
                save: { owner: { kind: "contextReference", value: { name: "user" } } },
            },
            canApplyAction: (_name, values) => Effect.succeed(values.owner === "alice"),
        },
    });
    expect(view.context).toEqual({ user: "alice" });
    expect(view.ir.actionTypes[0]?.parameters.map((parameter) => parameter.name)).toEqual(["id"]);
    await Effect.runPromise(
        Effect.gen(function* () {
            expect(
                (yield* view.backend.loadSubset({ objectType: "Item", query: { limit: 1 } })).rows
            ).toEqual([{ key: "visible", value: { id: "visible", owner: "alice" } }]);
            expect(
                yield* Effect.result(
                    view.backend.loadSubset({
                        objectType: "Item",
                        query: { where: eq(field("private"), "secret") },
                    })
                )
            ).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound" } });
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
                            source: o.Expression.objectLookup({
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
                            source: o.Expression.objectLookup({
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
    const backend: OntologyBackendService = {
        name: "test",
        sourceId: "test",
        supportsIdempotency: false,
        loadSubset: (subset) =>
            Effect.succeed({
                complete: true,
                rows: evaluateQuery(
                    [
                        {
                            key: "visible",
                            value: { id: "visible", owner: "alice", private: "never-disclose" },
                        },
                        { key: "hidden", value: { id: "hidden", owner: "bob", private: "never-disclose" } },
                    ],
                    subset.query ?? {}
                ),
            }),
        applyAction: (invocation) =>
            Effect.sync(() => {
                invoked = true;
                return { operationId: invocation.id, outcome: "committed" as const };
            }),
        queryFunction: () => Effect.void,
    };
    const view = projectOntologyBackend({
        backend,
        ir,
        context: {},
        policy: {
            allowedObjectTypeProperties: { Item: ["id", "owner"] },
            baseObjectTypeQueries: { Item: eq(field("owner"), "alice") },
            fixedActionParameterValues: { edit: { owner: o.Expression.literal({ value: "fixed-owner" }) } },
        },
    });
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
