import { describe, expect, it } from "vitest";
import { o, type OntologyIR } from "@party-stack/ontology";
import { createRemoteLiveOntology } from "./client.js";
import type { RemoteOntologyTransport } from "./protocol.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
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
            ],
            logic: [],
        },
    ],
};

describe("createRemoteLiveOntology", () => {
    it("uses describe to construct a live ontology with projected context", async () => {
        let appliedParameters: Record<string, unknown> | undefined;
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
            getAttachmentMetadata: async (request) => ({
                ...request.attachment,
                size: 0,
                type: "application/octet-stream",
                name: request.attachment.id,
            }),
            getAttachmentContent: async () => new Blob(),
        };

        const ontology = await createRemoteLiveOntology({ transport });
        await ontology.actions
            .createNote!({
                title: "Hello",
            })
            .mutationFn();

        expect(appliedParameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
        });
    });
});
