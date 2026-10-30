import { OntologyStorageError } from "@party-stack/ontology-storage";
import { BlobStorageError } from "@party-stack/ontology-storage/blobs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
    BackendError,
    classifyBackendFailure,
    isUnknownActionOutcome,
    projectBackendError,
} from "./errors.js";

describe("normalized failures", () => {
    it("preserves attachment recovery categories through storage and backend boundaries", () => {
        for (const [kind, expected, retryable] of [
            ["NotFound", "NotFound", false],
            ["Busy", "Conflict", true],
            ["Conflict", "Conflict", false],
            ["InvalidValue", "InvalidRequest", false],
            ["Bytes", "Unavailable", true],
        ] as const) {
            const blob = new BlobStorageError({ kind, message: "Private file path or backend details" });
            const storage = new OntologyStorageError({ operation: "attachment.retain", reason: blob });
            for (const cause of [blob, storage]) {
                const error = classifyBackendFailure("applyAction", cause);
                expect(error).toMatchObject({ kind: expected, retryable });
                expect(error.message).not.toContain("Private file path");
                if (kind === "NotFound" || kind === "Busy") expect(isUnknownActionOutcome(error)).toBe(false);
            }
        }
    });

    it("distinguishes Salesforce quota failures from permissions and authentication", () => {
        expect(
            classifyBackendFailure("applyAction", { statusCode: 403, errorCode: "REQUEST_LIMIT_EXCEEDED" })
        ).toMatchObject({ kind: "RateLimited", retryable: true, actionOutcome: "not-committed" });
        expect(
            classifyBackendFailure("applyAction", { statusCode: 401, errorCode: "INVALID_SESSION_ID" }).kind
        ).toBe("Unauthenticated");
        expect(classifyBackendFailure("applyAction", { statusCode: 403 }).kind).toBe("Forbidden");
        expect(isUnknownActionOutcome(classifyBackendFailure("applyAction", { statusCode: 503 }))).toBe(true);
    });
    it("classifies nested HTTP transport statuses without exposing response bodies", () => {
        expect(
            classifyBackendFailure("applyAction", { reason: { response: { status: 401, headers: {} } } })
        ).toMatchObject({ kind: "Unauthenticated", actionOutcome: "not-committed" });
        expect(
            classifyBackendFailure("load", {
                cause: { response: { status: 429, headers: { "retry-after": "2" } } },
            })
        ).toMatchObject({ kind: "RateLimited", retryAfterMs: 2_000 });
    });
    it("retains explicit authored failures without treating runtime messages as user-facing", () => {
        const error = classifyBackendFailure("applyAction", {
            errorName: "FunctionEncounteredUserFacingError",
            parameters: { message: "Choose another date.", functionRid: "private" },
        });
        expect(error.issues).toEqual([
            {
                message: "Choose another date.",
                code: "custom",
                category: "custom",
                source: "user-facing",
                messageSource: "configured",
            },
        ]);
        expect(
            classifyBackendFailure("applyAction", {
                errorName: "FunctionExecutionFailed",
                parameters: { message: "password=secret" },
            }).issues
        ).toBeUndefined();
    });
    it("projects structured field issues and never encodes raw causes", () => {
        const privateError = new BackendError({
            operation: "applyAction",
            kind: "ValidationFailed",
            message: "private detail",
            retryable: false,
            actionOutcome: "not-committed",
            cause: new Error("password=secret"),
            issues: [
                {
                    code: "arraySize",
                    category: "input",
                    messageSource: "standard",
                    path: ["items"],
                    message: "Choose an allowed number of items.",
                },
                {
                    code: "custom",
                    category: "custom",
                    path: ["items"],
                    message: "Member of private group required.",
                },
                {
                    code: "required",
                    category: "input",
                    messageSource: "standard",
                    path: ["hidden"],
                    message: "A value is required.",
                },
            ],
        });
        const error = projectBackendError(privateError, "projected", { parameters: ["items"] });
        expect(error.issues).toEqual([
            {
                code: "arraySize",
                path: ["items"],
                message: "Choose an allowed number of items.",
                category: "input",
                messageSource: "standard",
            },
        ]);
        expect(projectBackendError(error, "projected", { parameters: ["items"] }).issues).toEqual(
            error.issues
        );
        expect(JSON.stringify(Schema.encodeSync(BackendError)(error))).not.toMatch(
            /secret|private detail|private group|hidden/
        );
    });
    it("replaces configured input messages and conceals private reference criteria", () => {
        const error = new BackendError({
            operation: "validate",
            kind: "ValidationFailed",
            message: "private",
            retryable: false,
            issues: [
                {
                    path: ["items"],
                    code: "arraySize",
                    category: "input",
                    messageSource: "configured",
                    message: "Private team policy",
                },
                {
                    path: ["assignee"],
                    code: "InvalidObjectReference",
                    category: "reference",
                    message: "Private query",
                },
            ],
        });
        expect(projectBackendError(error, "projected", { parameters: ["items", "assignee"] }).issues).toEqual(
            [
                {
                    path: ["items"],
                    code: "arraySize",
                    message: "Choose an allowed number of items.",
                    category: "input",
                    messageSource: "standard",
                },
                { path: ["assignee"], code: "InvalidObjectReference", message: "Choose a valid value." },
            ]
        );
    });
    it("custom projection may conceal existence but cannot invent a safe write outcome", () => {
        const error = new BackendError({
            operation: "applyAction",
            kind: "Unavailable",
            message: "upstream",
            retryable: true,
            actionOutcome: "unknown",
        });
        const shown = projectBackendError(
            error,
            () =>
                new BackendError({
                    operation: "applyAction",
                    kind: "NotFound",
                    message: "Not found.",
                    retryable: false,
                    actionOutcome: "not-committed",
                })
        );
        expect(shown).toMatchObject({ kind: "NotFound", retryable: true, actionOutcome: "unknown" });
        expect(
            projectBackendError(classifyBackendFailure("load", { statusCode: 401 }), "projected", {
                upstream: true,
            }).kind
        ).toBe("Unavailable");
    });
});

it("separates bad requests and provider validation, and preserves storage classifications", async () => {
    const { OntologyStorageError, QueryError, CodecError, ConfigurationError } =
        await import("@party-stack/ontology-storage");
    expect(classifyBackendFailure("loadSubset", { status: 400 })).toMatchObject({
        kind: "InvalidRequest",
        retryable: false,
    });
    expect(
        classifyBackendFailure("applyAction", { errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION" }).kind
    ).toBe("ValidationFailed");
    for (const [reason, kind] of [
        [new QueryError({ message: "bad predicate" }), "InvalidRequest"],
        [new CodecError({ message: "corrupt stored row", direction: "decode" }), "Internal"],
        [new ConfigurationError({ message: "invalid setup" }), "InvalidConfiguration"],
    ] as const)
        expect(
            classifyBackendFailure("storage", new OntologyStorageError({ operation: "test", reason }))
        ).toMatchObject({ kind, retryable: false });
});

it("does not disguise native Effect RPC decoding failures as retryable network failures", async () => {
    const { RpcClientError } = await import("effect/rpc");
    const cause = new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({ message: "bad response", cause: { private: "secret" } }),
    });
    const error = classifyBackendFailure("applyAction", cause);
    expect(error).toMatchObject({ kind: "InvalidResponse", retryable: false, actionOutcome: "unknown" });
    expect(isUnknownActionOutcome(error)).toBe(true);
    expect(JSON.stringify(projectBackendError(error))).not.toContain("secret");
});

it("keeps HTTP status separate from the detailed error kind", async () => {
    const { backendErrorStatus } = await import("./errors.js");
    expect(backendErrorStatus({ kind: "ValidationFailed" })).toBe(422);
    expect(backendErrorStatus({ kind: "InvalidRequest" })).toBe(400);
    expect(backendErrorStatus({ kind: "InvalidResponse" })).toBe(502);
    expect(backendErrorStatus({ kind: "InvalidConfiguration" })).toBe(500);
    expect(backendErrorStatus({ kind: "HistoryExpired" })).toBe(409);
    expect(backendErrorStatus({ kind: "SchemaMismatch" })).toBe(409);
});
