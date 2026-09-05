import { describe, expect, it, vi } from "vitest";
import { Temporal } from "temporal-polyfill";
import { o, type OntologyIR } from "@party-stack/ontology";
import {
    createRemoteLiveOntology,
    createRemoteOntologyBackendAdapter,
    type OntologyApplyActionClientResult,
} from "./client.js";
import type { RemoteOntologyTransport } from "./protocol.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                { name: "title", displayName: "Title", type: o.string({}) },
                {
                    name: "ownerEmail",
                    displayName: "Owner",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({ path: ["user", "email"] }),
                },
                { name: "dueDate", displayName: "Due date", type: o.date({}) },
            ],
            logic: [],
        },
    ],
    queryFunctionTypes: [
        {
            name: "greet",
            displayName: "Greet",
            parameters: [{ name: "name", displayName: "Name", type: o.string({}) }],
            returnType: o.string({}),
        },
    ],
};

describe("createRemoteLiveOntology", () => {
    it("uses describe to construct a live ontology with projected context", async () => {
        let appliedParameters: Record<string, unknown> | undefined;
        let validatedParameters: Record<string, unknown> | undefined;
        const transport: RemoteOntologyTransport = {
            describe: async () => ({
                ir,
                context: { user: { email: "alice@example.com" } },
            }),
            loadSubset: async (request) => ({
                objectType: request.objectType,
                objects: [],
            }),
            applyAction: async (request) => {
                appliedParameters = request.parameters;
                return {};
            },
            validateAction: async (request) => {
                validatedParameters = request.parameters;
                return {
                    certain: true,
                    value: {
                        kind: "ok",
                        value: null,
                    },
                };
            },
            runQueryFunction: async (request) => ({
                value: `Hello ${request.parameters.name}`,
            }),
            getAttachmentMetadata: async (request) => ({
                ...request.attachment,
                size: 0,
                type: "application/octet-stream",
                name: request.attachment.id,
            }),
            getAttachmentContent: async () => new Blob(),
        };

        const ontology = await createRemoteLiveOntology({ transport });
        await ontology.actions.createNote!({
            title: "Hello",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });

        expect(appliedParameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });
        await expect(
            ontology.actions.createNote!.validate({
                title: "Hello",
                dueDate: Temporal.PlainDate.from("2026-06-15"),
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "ok",
                value: undefined,
            },
        });
        expect(validatedParameters).toEqual(appliedParameters);
        await expect(
            ontology.actions.createNote!.validateDraft(
                {
                    title: "Hello",
                },
                {
                    knownParameters: ["title"],
                }
            )
        ).resolves.toEqual({
            certain: false,
        });
        await expect(ontology.queryFunctions.greet!({ name: "Alice" })).resolves.toBe("Hello Alice");
        await ontology.cleanup();
    });
});

describe("createRemoteOntologyBackendAdapter.applyAction", () => {
    it("resolves successful writes even when subsequent refetches reject or abort", async () => {
        const transport: RemoteOntologyTransport = {
            describe: async () => ({ ir }),
            loadSubset: async (request) => ({
                objectType: request.objectType,
                objects: [],
            }),
            applyAction: async () => ({
                invalidatedObjectTypes: ["Note"],
                attachmentIdMappings: [{ localId: "local", remoteId: "remote" }],
            }),
            validateAction: async () => ({
                certain: false,
            }),
            runQueryFunction: async () => ({ value: undefined }),
            getAttachmentMetadata: async () => ({}),
            getAttachmentContent: async () => new Blob(),
        };
        const adapter = createRemoteOntologyBackendAdapter({ ir, transport });
        const abortError = new DOMException("The operation was aborted.", "AbortError");
        const refetch = vi
            .fn()
            .mockRejectedValueOnce(abortError)
            .mockRejectedValueOnce(new Error("network failed"));

        const first = (await adapter.applyAction(
            "createNote",
            { title: "one" },
            {
                objects: {
                    Note: {
                        utils: { refetch },
                    } as never,
                },
            }
        )) as OntologyApplyActionClientResult;

        expect(first.attachmentIdMappings).toEqual([{ localId: "local", remoteId: "remote" }]);
        expect(first.invalidatedObjectTypes).toEqual(["Note"]);
        expect(() => structuredClone(first)).not.toThrow();

        await adapter.applyAction(
            "createNote",
            { title: "two" },
            {
                objects: {
                    Note: {
                        utils: { refetch },
                    } as never,
                },
            }
        );

        expect(refetch).toHaveBeenCalledTimes(2);
    });

    it("does not confirm an action before its collection refresh finishes", async () => {
        let finishRefresh!: () => void;
        const refreshFinished = new Promise<void>((resolve) => {
            finishRefresh = resolve;
        });
        const refetch = vi.fn(async () => {
            await refreshFinished;
            return [];
        });
        const adapter = createRemoteOntologyBackendAdapter({
            ir,
            transport: {
                describe: async () => ({ ir }),
                loadSubset: async (request) => ({
                    objectType: request.objectType,
                    objects: [],
                }),
                applyAction: async () => ({ invalidatedObjectTypes: ["Note"] }),
                validateAction: async () => ({
                    certain: true,
                    value: {
                        kind: "ok",
                        value: null,
                    },
                }),
                runQueryFunction: async () => ({ value: undefined }),
                getAttachmentMetadata: async () => ({}),
                getAttachmentContent: async () => new Blob(),
            },
        });

        let confirmed = false;
        const confirmation = adapter
            .applyAction("createNote", { title: "one" }, {
                objects: {
                    Note: {
                        utils: { refetch },
                    } as never,
                },
            })
            .then(() => {
                confirmed = true;
            });

        await vi.waitFor(() => expect(refetch).toHaveBeenCalledOnce());
        expect(confirmed).toBe(false);
        finishRefresh();
        await confirmation;
        expect(confirmed).toBe(true);
    });
});
