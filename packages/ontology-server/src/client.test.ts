import { o, type OntologyIR } from "@party-stack/ontology";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRemoteLiveOntology, createRemoteOntologyBackendAdapter } from "./client.js";
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
                    defaultValue: o.Expression.getAt({
                        source: o.Expression.contextReference({
                            name: "user",
                        }),
                        path: ["email"],
                    }),
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
        let resolutionRequest: Record<string, unknown> | undefined;
        const transport: RemoteOntologyTransport = {
            describe: async () => ({
                ir,
                context: { user: { email: "alice@example.com" } },
                capabilities: {
                    actionParameterResolution: true,
                },
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
            resolveActionParameters: async (request) => {
                resolutionRequest = request.parameters;
                return {
                    parameters: {
                        ...request.parameters,
                        ownerEmail: "resolved@example.com",
                    },
                };
            },
            runQueryFunction: async (request) => {
                if (typeof request.parameters.name !== "string") throw new Error("Expected a string name");
                return { value: `Hello ${request.parameters.name}` };
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
        await expect(
            ontology.actions.createNote!.resolveParameters({
                title: "Hello",
                dueDate: Temporal.PlainDate.from("2026-06-15"),
            })
        ).resolves.toEqual({
            title: "Hello",
            ownerEmail: "resolved@example.com",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });
        expect(resolutionRequest).toEqual({
            title: "Hello",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });
        resolutionRequest = undefined;

        await ontology.actions.createNote!({
            title: "Hello",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });

        expect(appliedParameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });
        expect(resolutionRequest).toBeUndefined();
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
        expect(validatedParameters).toEqual({
            title: "Hello",
            dueDate: Temporal.PlainDate.from("2026-06-15"),
        });
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

describe("native remote backend binding", () => {
    const transport = (overrides: Partial<RemoteOntologyTransport> = {}): RemoteOntologyTransport => ({
        describe: async () => ({ ir }),
        loadSubset: async (request) => ({ objectType: request.objectType, objects: [] }),
        applyAction: async () => ({}),
        validateAction: async () => ({ certain: false }),
        runQueryFunction: async () => ({ value: undefined }),
        getAttachmentMetadata: async () => ({}),
        getAttachmentContent: async () => new Blob(),
        ...overrides,
    });
    it("returns receipts and attachment mappings without touching UI collections", async () => {
        const load = vi.fn(async (request) => ({ objectType: request.objectType, objects: [] }));
        const binding = createRemoteOntologyBackendAdapter({
            ir,

            transport: transport({
                loadSubset: load,
                applyAction: async () => ({
                    invalidatedObjectTypes: ["Note"],
                    attachmentIdMappings: [{ localId: "local", remoteId: "remote" }],
                }),
            }),
        });
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* binding.open({});
                    expect(
                        yield* backend.invoke({ id: "one", name: "createNote", parameters: {} })
                    ).toMatchObject({
                        invocationId: "one",
                        outcome: "committed",
                        attachmentIdMappings: [{ localId: "local", remoteId: "remote" }],
                    });
                })
            )
        );
        expect(load).not.toHaveBeenCalled();
    });
    it("keeps equal subset requests independently interruptible", async () => {
        const requests: {
            resolve: (value: { objectType: string; objects: Record<string, unknown>[] }) => void;
            signal?: AbortSignal;
        }[] = [];
        const binding = createRemoteOntologyBackendAdapter({
            ir,
            transport: transport({
                loadSubset: (request, options) =>
                    new Promise((resolve, reject) => {
                        requests.push({ resolve, signal: options?.signal });
                        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                            once: true,
                        });
                    }),
            }),
        });
        const a = new AbortController();
        const b = new AbortController();
        const backend = await Effect.runPromise(Effect.scoped(binding.open({})));
        const first = Effect.runPromise(backend.loadSubset({ objectType: "Note" }), { signal: a.signal });
        const second = Effect.runPromise(backend.loadSubset({ objectType: "Note" }), { signal: b.signal });
        const interrupted = first.then(
            () => false,
            () => true
        );
        await vi.waitFor(() => expect(requests).toHaveLength(2));
        a.abort();
        expect(await interrupted).toBe(true);
        expect(requests[0]?.signal?.aborted).toBe(true);
        expect(requests[1]?.signal?.aborted).toBe(false);
        requests[1]!.resolve({ objectType: "Note", objects: [{ id: "two" }] });
        expect(await second).toMatchObject({ rows: [{ key: "two", value: { id: "two" } }] });
    });
});
