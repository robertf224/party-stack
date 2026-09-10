import {
    createCollection,
    localOnlyCollectionOptions,
} from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import {
    afterAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { o, type OntologyIR } from "../../ir/index.js";
import { createLiveOntologyAction } from "./createLiveOntologyAction.js";
import type { OntologyObject } from "../objects/OntologyObject.js";
import type { OntologyActionRequest } from "../outbox/types.js";

const users = createCollection(
    localOnlyCollectionOptions<
        OntologyObject,
        string | number
    >({
        id: "resolve-action-parameters-users",
        getKey: (user) => user.id as string | number,
        initialData: [
            {
                id: "user-1",
                profile: { name: "Ada" },
            },
        ],
    })
);

const action: OntologyIR["actionTypes"][number] = {
    name: "resolveDefaults",
    displayName: "Resolve defaults",
    parameters: [
        {
            name: "chained",
            displayName: "Chained",
            type: o.string({}),
            defaultValue:
                o.Expression.inputReference({
                    name: "base",
                }),
        },
        {
            name: "base",
            displayName: "Base",
            type: o.string({}),
            defaultValue: o.Expression.literal({
                value: "base",
            }),
        },
        {
            name: "actor",
            displayName: "Actor",
            type: o.string({}),
            defaultValue:
                o.Expression.contextReference({
                    name: "actor",
                }),
        },
        {
            name: "entries",
            displayName: "Entries",
            type: o.list({
                elementType: o.struct({
                    fields: [
                        {
                            name: "code",
                            displayName: "Code",
                            type: o.string({}),
                        },
                    ],
                }),
            }),
        },
        {
            name: "mapped",
            displayName: "Mapped",
            type: o.list({
                elementType: o.struct({
                    fields: [
                        {
                            name: "label",
                            displayName: "Label",
                            type: o.string({}),
                        },
                    ],
                }),
            }),
            defaultValue: o.Expression.map({
                source: o.Expression.inputReference({
                    name: "entries",
                }),
                binding: "entry",
                body: o.Expression.struct({
                    fields: [
                        {
                            name: "label",
                            value: o.Expression.getAt({
                                source: o.Expression.localReference({
                                    name: "entry",
                                }),
                                path: ["code"],
                            }),
                        },
                    ],
                }),
            }),
        },
        {
            name: "user",
            displayName: "User",
            type: o.objectReference({
                objectType: "User",
            }),
        },
        {
            name: "userName",
            displayName: "User name",
            type: o.string({}),
            defaultValue: o.Expression.getAt({
                source: o.Expression.objectLookup({
                    reference:
                        o.Expression.inputReference({
                            name: "user",
                        }),
                }),
                path: ["profile", "name"],
            }),
        },
        {
            name: "id",
            displayName: "ID",
            type: o.string({}),
            defaultValue: o.Expression.uuid({}),
        },
        {
            name: "createdAt",
            displayName: "Created at",
            type: o.timestamp({}),
            defaultValue: o.Expression.now({}),
        },
    ],
    logic: [],
};

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "profile",
                    displayName: "Profile",
                    type: o.struct({
                        fields: [
                            {
                                name: "name",
                                displayName: "Name",
                                type: o.string({}),
                            },
                        ],
                    }),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [action],
    queryFunctionTypes: [],
};

const liveAction = createLiveOntologyAction({
    ir,
    action,
    context: { actor: "user-1" },
    objects: { User: users },
    submit: vi.fn(),
    validate: vi.fn(),
    validateDraft: vi.fn(),
});

describe("LiveOntologyAction.resolveParameters", () => {
    afterAll(async () => {
        await users.cleanup();
    });

    it("resolves defaults from partial parameters", async () => {
        await users.preload();

        const resolved =
            await liveAction.resolveParameters({
                entries: [{ code: "alpha" }],
                user: "user-1",
            });

        expect(resolved).toMatchObject({
            base: "base",
            chained: "base",
            actor: "user-1",
            entries: [{ code: "alpha" }],
            mapped: [{ label: "alpha" }],
            user: "user-1",
            userName: "Ada",
        });
        expect(resolved.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
        expect(resolved.createdAt).toBeInstanceOf(
            Temporal.Instant
        );
    });

    it("keeps supplied values instead of evaluating defaults", async () => {
        const createdAt = Temporal.Instant.from(
            "2026-09-08T12:00:00Z"
        );
        const supplied = {
            base: "supplied base",
            chained: "supplied chained",
            actor: "supplied actor",
            entries: [{ code: "input" }],
            mapped: [{ label: "supplied mapping" }],
            user: "user-1",
            userName: "supplied name",
            id: "supplied-id",
            createdAt,
        };

        await expect(
            liveAction.resolveParameters(supplied)
        ).resolves.toEqual(supplied);
    });
});

describe("LiveOntologyAction submission", () => {
    it("submits provided parameters without resolving defaults", async () => {
        const submit = vi.fn((request: OntologyActionRequest) => {
            void request;
            return Promise.resolve();
        });
        const actionWithDefaults = createLiveOntologyAction({
            ir,
            action,
            context: { actor: "user-1" },
            objects: { User: users },
            submit,
            validate: vi.fn(),
            validateDraft: vi.fn(),
        });
        const provided = {
            entries: [{ code: "alpha" }],
            user: "user-1",
        };

        await actionWithDefaults(provided);

        expect(submit.mock.calls[0]?.[0].parameters).toEqual(provided);
    });
});
