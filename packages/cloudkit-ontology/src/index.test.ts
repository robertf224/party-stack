import {
    createLiveOntology,
    o,
    type OntologyIR,
} from "@party-stack/ontology";
import { createMemoryCloudKitClient } from "@party-stack/cloudkit-client/testing";
import { describe, expect, it, vi } from "vitest";
import { eq, queryOnce } from "@tanstack/db";
import type { attachment as OntologyAttachment } from "@party-stack/ontology/values";
import { createCloudKitOntologyBackendAdapter } from "./index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "updatedAt",
                    displayName: "Updated at",
                    type: o.timestamp({}),
                },
                {
                    name: "summary",
                    displayName: "Summary",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
            ],
        },
        {
            name: "NoteAttachment",
            displayName: "Note attachment",
            pluralDisplayName: "Note attachments",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "noteId",
                    displayName: "Note ID",
                    type: o.string({}),
                },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["id"],
                            }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(
                                o.FunctionCallExpression.now({})
                            ),
                        },
                    ],
                }),
            ],
        },
        {
            name: "copyUpdatedTitle",
            displayName: "Copy updated title",
            parameters: [
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({
                        objectType: "Note",
                    }),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { path: ["note"] },
                    values: [
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                    ],
                }),
                o.ActionLogicStep.updateObject({
                    object: { path: ["note"] },
                    values: [
                        {
                            property: ["summary"],
                            value: o.Expression.valueReference({
                                path: ["note", "title"],
                            }),
                        },
                    ],
                }),
            ],
        },
        {
            name: "createNoteAttachment",
            displayName: "Create note attachment",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({
                        objectType: "Note",
                    }),
                },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "NoteAttachment",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["id"],
                            }),
                        },
                        {
                            property: ["noteId"],
                            value: o.Expression.valueReference({
                                path: ["note"],
                            }),
                        },
                        {
                            property: ["attachment"],
                            value: o.Expression.valueReference({
                                path: ["attachment"],
                            }),
                        },
                    ],
                }),
                o.ActionLogicStep.updateObject({
                    object: { path: ["note"] },
                    values: [
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(
                                o.FunctionCallExpression.now({})
                            ),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [],
};

describe("CloudKit ontology adapter", () => {
    it("executes actions and incrementally hydrates another client", async () => {
        const client = createMemoryCloudKitClient();
        const first = await createLiveOntology({
            ir,
            backend: () =>
                createCloudKitOntologyBackendAdapter({
                    ir,
                    client,
                }),
        });

        await first.actions.createNote!({
            id: "note-1",
            title: "Hello",
        });

        const second = await createLiveOntology({
            ir,
            backend: () =>
                createCloudKitOntologyBackendAdapter({
                    ir,
                    client,
                }),
        });
        await queryOnce((query) =>
            query
                .from({ note: second.objects.Note! })
                .where(({ note }) => eq(note.id, "note-1"))
                .findOne()
        );

        expect(second.objects.Note!.get("note-1")).toMatchObject({
            id: "note-1",
            title: "Hello",
        });
        expect(
            second.objects.Note!.get("note-1")?.updatedAt
        ).toHaveProperty("epochMilliseconds");

        await first.cleanup();
        await second.cleanup();
    });

    it("stores and reads CloudKit assets", async () => {
        const client = createMemoryCloudKitClient();
        const ontology = await createLiveOntology({
            ir,
            backend: () =>
                createCloudKitOntologyBackendAdapter({
                    ir,
                    client,
                }),
        });
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
        });
        const creation = await ontology.attachments.create(
            new File(["hello attachment"], "hello.txt", {
                type: "text/plain",
            }),
            {
                target: {
                    kind: "objectProperty",
                    objectType: "NoteAttachment",
                    property: "attachment",
                },
            }
        );
        const attachment =
            creation.attachment as unknown as OntologyAttachment;

        await ontology.actions.createNoteAttachment!({
            id: "attachment-object-1",
            note: "note-1",
            attachment,
        });

        expect(
            await ontology.attachments.metadata(attachment)
        ).toMatchObject({
            name: "hello.txt",
            size: 16,
            type: "text/plain",
        });
        expect(
            await (
                await ontology.attachments.blob(attachment)
            ).text()
        ).toBe("hello attachment");
        await ontology.cleanup();
    });

    it("preserves read-your-writes across action steps", async () => {
        const client = createMemoryCloudKitClient();
        const ontology = await createLiveOntology({
            ir,
            backend: () =>
                createCloudKitOntologyBackendAdapter({
                    ir,
                    client,
                }),
        });
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Before",
        });

        await ontology.actions.copyUpdatedTitle!({
            note: "note-1",
            title: "After",
        });

        expect(ontology.objects.Note!.get("note-1")).toMatchObject({
            title: "After",
            summary: "After",
        });
        await ontology.cleanup();
    });

    it("projects optimistic outbox edits before CloudKit confirms", async () => {
        const baseClient = createMemoryCloudKitClient();
        let confirmWrite!: () => void;
        const writeConfirmation = new Promise<void>((resolve) => {
            confirmWrite = resolve;
        });
        const client = {
            ...baseClient,
            async modifyRecords(
                options: Parameters<
                    typeof baseClient.modifyRecords
                >[0]
            ) {
                await writeConfirmation;
                return baseClient.modifyRecords(options);
            },
        };
        const ontology = await createLiveOntology({
            ir,
            backend: () =>
                createCloudKitOntologyBackendAdapter({
                    ir,
                    client,
                }),
            writes: {
                defaultMode: "outbox",
                defaultVisibility: "optimistic",
                outbox: { maxRetries: 0 },
            },
        });
        await ontology.outbox.ready;

        const completed = ontology.actions.createNote!({
            id: "note-1",
            title: "Immediate",
        });
        await vi.waitFor(() => {
            expect(
                ontology.objects.Note!.get("note-1")
            ).toMatchObject({ title: "Immediate" });
        });

        confirmWrite();
        await completed;
        expect(
            ontology.objects.Note!.get("note-1")
        ).toMatchObject({ title: "Immediate" });
        await ontology.cleanup();
    });

    it("treats a repeated idempotency key as success", async () => {
        const client = createMemoryCloudKitClient();
        const adapter = createCloudKitOntologyBackendAdapter({
            ir,
            client,
        });
        const ontology = await createLiveOntology({
            ir,
            backend: () => adapter,
        });

        await adapter.applyAction(
            "createNote",
            { id: "note-1", title: "Hello" },
            {
                objects: ontology.objects,
                idempotencyKey: "same-action",
            }
        );
        await expect(
            adapter.applyAction(
                "createNote",
                { id: "note-1", title: "Hello" },
                {
                    objects: ontology.objects,
                    idempotencyKey: "same-action",
                }
            )
        ).resolves.toBeUndefined();

        await ontology.cleanup();
    });
});
