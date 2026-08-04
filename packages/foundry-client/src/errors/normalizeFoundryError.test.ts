import { describe, expect, it } from "vitest";
import {
    FoundryActionValidationError,
    FoundryError,
    isFoundryAuthError,
    isFoundryNotFoundError,
    normalizeFoundryError,
} from "./normalizeFoundryError.js";

describe("normalizeFoundryError", () => {
    it("normalizes Palantir-like API errors structurally", () => {
        const cause = {
            message: "Object not found",
            statusCode: 404,
            errorCode: "NOT_FOUND",
            errorName: "ObjectNotFound",
            errorInstanceId: "abc",
            parameters: { objectType: "Employee", primaryKey: "1" },
        };

        const normalized = normalizeFoundryError(cause);
        expect(normalized).toBeInstanceOf(FoundryError);
        expect(normalized).toMatchObject({
            message: "Object not found",
            statusCode: 404,
            errorCode: "NOT_FOUND",
            errorName: "ObjectNotFound",
            errorInstanceId: "abc",
            parameters: { objectType: "Employee", primaryKey: "1" },
        });
        expect(normalized.cause).toBe(cause);
        expect(isFoundryNotFoundError(cause)).toBe(true);
    });

    it("normalizes action validation errors", () => {
        const cause = {
            name: "ActionValidationError",
            message: "Invalid parameters",
            errorCode: "INVALID_ARGUMENT",
            validation: { result: "INVALID", parameters: { title: { result: "INVALID" } } },
            parameters: { actionType: "createPost" },
        };

        const normalized = normalizeFoundryError(cause);
        expect(normalized).toBeInstanceOf(FoundryActionValidationError);
        expect(normalized).toMatchObject({
            message: "Invalid parameters",
            errorCode: "INVALID_ARGUMENT",
            errorName: "ActionValidationError",
        });
        expect((normalized as FoundryActionValidationError).validation).toEqual(cause.validation);
    });

    it("finds structured validation details through non-retryable wrappers", () => {
        const validation = {
            result: "INVALID",
            parameters: { title: { result: "INVALID", message: "Required" } },
        };
        const cause = new FoundryActionValidationError("Invalid Action arguments.", {
            statusCode: 400,
            validation,
            parameters: { actionType: "createPost" },
        });
        const wrapper = new Error("Action execution is non-retryable.", { cause });
        wrapper.name = "NonRetryableError";

        const normalized = normalizeFoundryError(wrapper);
        expect(normalized).toBeInstanceOf(FoundryActionValidationError);
        expect(normalized).toMatchObject({
            message: "Action execution is non-retryable.",
            statusCode: 400,
            errorCode: "INVALID_ARGUMENT",
            errorName: "ActionValidationError",
            parameters: { actionType: "createPost" },
            validation,
        });
        expect(normalized.cause).toBe(wrapper);
    });

    it("handles unknown and malformed payloads while preserving causes", () => {
        expect(normalizeFoundryError("boom")).toMatchObject({
            message: "boom",
        });
        expect(normalizeFoundryError(null).message).toBe("Unknown Foundry error.");
        expect(normalizeFoundryError({ statusCode: "nope", parameters: "bad" }).message).toBe(
            "Unknown Foundry error."
        );

        const original = new Error("network down");
        const normalized = normalizeFoundryError(original);
        expect(normalized.message).toBe("network down");
        expect(normalized.cause).toBe(original);
    });

    it("returns existing Party Stack errors unchanged", () => {
        const existing = new FoundryError("already normalized", { errorCode: "CONFLICT", statusCode: 409 });
        expect(normalizeFoundryError(existing)).toBe(existing);
    });

    it("detects auth errors", () => {
        expect(isFoundryAuthError({ statusCode: 401, errorCode: "UNAUTHORIZED" })).toBe(true);
        expect(isFoundryAuthError({ statusCode: 403 })).toBe(true);
        expect(isFoundryAuthError({ statusCode: 500 })).toBe(false);
    });
});
