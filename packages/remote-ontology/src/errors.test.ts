import { describe, expect, it } from "vitest";
import {
    parseRemoteOntologyErrorBody,
    RemoteOntologyError,
    remoteOntologyErrorFromUnknown,
} from "./errors.js";
import { createHttpRemoteOntologyTransport } from "./http.js";
import { createRemoteOntologyServer } from "./server.js";
import { serializeRemoteOntologyJson } from "./protocol.js";
import { o, type OntologyBackendAdapter, type OntologyIR } from "@party-stack/ontology";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [{ name: "title", displayName: "Title", type: o.string({}) }],
            logic: [],
        },
    ],
    queryFunctionTypes: [],
};

const backendAdapter: OntologyBackendAdapter = {
    name: "test",
    getCollectionOptions: () => ({
        syncMode: "eager",
        sync: {
            sync: ({ markReady }) => {
                markReady();
            },
        },
    }),
    applyAction: async () => {},
    runQueryFunction: async () => undefined,
};

describe("remote ontology error protocol", () => {
    it("round-trips structured 400/403/404/validation/500 errors over HTTP", async () => {
        const cases = [
            {
                status: 400,
                envelope: {
                    v: 1 as const,
                    name: "ZodError",
                    code: "BAD_REQUEST" as const,
                    status: 400,
                    message: "Invalid request",
                    retryable: false,
                },
            },
            {
                status: 403,
                envelope: {
                    v: 1 as const,
                    name: "RemoteOntologyForbiddenError",
                    code: "FORBIDDEN" as const,
                    status: 403,
                    message: "Action denied",
                    retryable: false,
                },
            },
            {
                status: 404,
                envelope: {
                    v: 1 as const,
                    name: "NonRetryableError",
                    code: "NOT_FOUND" as const,
                    status: 404,
                    message: "Missing object",
                    retryable: false,
                },
            },
            {
                status: 400,
                envelope: {
                    v: 1 as const,
                    name: "NonRetryableError",
                    code: "VALIDATION" as const,
                    status: 400,
                    message: "Invalid Action arguments.",
                    retryable: false,
                    details: { parameters: { title: "required" } },
                },
            },
            {
                status: 500,
                envelope: {
                    v: 1 as const,
                    name: "Error",
                    code: "INTERNAL" as const,
                    status: 500,
                    message: "boom",
                    retryable: true,
                },
            },
        ];

        for (const testCase of cases) {
            const transport = createHttpRemoteOntologyTransport({
                url: "https://example.test/remote/",
                ir,
                fetch: async () =>
                    new Response(JSON.stringify(testCase.envelope), {
                        status: testCase.status,
                        headers: { "content-type": "application/json" },
                    }),
            });

            await expect(transport.applyAction({ actionType: "createNote", parameters: {} })).rejects.toMatchObject(
                {
                    name: testCase.envelope.name,
                    code: testCase.envelope.code,
                    status: testCase.envelope.status,
                    message: testCase.envelope.message,
                    retryable: testCase.envelope.retryable,
                }
            );
        }
    });

    it("parses legacy { error } bodies and serializes forbidden responses from the server", async () => {
        const legacy = parseRemoteOntologyErrorBody(JSON.stringify({ error: "nope" }), 403);
        expect(legacy).toBeInstanceOf(RemoteOntologyError);
        expect(legacy).toMatchObject({
            code: "FORBIDDEN",
            status: 403,
            message: "nope",
            retryable: false,
        });

        const server = createRemoteOntologyServer({
            ir,
            backendAdapter,
            policy: {
                canApplyAction: () => false,
            },
        });
        const response = await server.handleRequest(
            new Request("http://example.test/apply-action", {
                method: "POST",
                body: serializeRemoteOntologyJson({
                    actionType: "createNote",
                    parameters: { title: "x" },
                }),
            })
        );
        expect(response.status).toBe(403);
        const body = JSON.parse(await response.text());
        expect(body).toMatchObject({
            v: 1,
            code: "FORBIDDEN",
            status: 403,
            retryable: false,
            message: 'Action "createNote" is not allowed.',
        });
        expect(RemoteOntologyError.fromEnvelope(body).toJSON()).toEqual(body);

        const methodResponse = await server.handleRequest(
            new Request("http://example.test/describe"),
        );
        expect(methodResponse.status).toBe(405);
        await expect(
            methodResponse.json(),
        ).resolves.toMatchObject({
            code: "BAD_REQUEST",
            status: 405,
            retryable: false,
        });
    });

    it("maps unknown failures to sanitized internal errors", () => {
        const error = remoteOntologyErrorFromUnknown(new Error("secret stack details"));
        expect(error).toMatchObject({
            code: "INTERNAL",
            status: 500,
            retryable: true,
            message: "secret stack details",
        });
    });
});
