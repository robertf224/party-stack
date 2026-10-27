import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { describe, expect, it } from "vite-plus/test";
import { foundryActionError } from "./foundryActionError.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [
        {
            name: "create",
            displayName: "Create",
            logic: [],
            parameters: [
                {
                    name: "project",
                    displayName: "Project",
                    type: o.optional({ type: o.objectReference({ objectType: "Project" }) }),
                },
                {
                    name: "reviewers",
                    displayName: "Reviewers",
                    type: o.list({ elementType: o.objectReference({ objectType: "User" }) }),
                },
            ],
        },
    ],
};
const normalize = (cause: unknown) =>
    foundryActionError("foundry.invoke", cause, ir, "create", {
        project: "gone",
        reviewers: ["valid", "missing"],
    });

describe("Foundry action reference errors", () => {
    it("preserves a provider parameter path instead of the SDK's generic 404 message", () => {
        const cause = Object.assign(new Error("Failed to fetch: 404"), {
            statusCode: 404,
            errorCode: "NOT_FOUND",
            errorName: "ActionParameterObjectNotFound",
            parameters: { parameterId: "project" },
        });
        expect(normalize(cause)).toMatchObject({
            kind: "ValidationFailed",
            invocationOutcome: "not-committed",
            retryable: false,
            issues: [
                {
                    path: ["project"],
                    code: "InvalidObjectReference",
                    category: "reference",
                    message: "Choose a valid value.",
                },
            ],
        });
        expect(normalize(cause).message).not.toContain("404");
    });
    it("matches object identity only to declared reference inputs, including list entries", () => {
        expect(
            normalize({
                cause: {
                    statusCode: 404,
                    errorName: "ontology:ParameterObjectNotFound",
                    parameters: { objectType: "User", primaryKey: "missing" },
                },
            })
        ).toMatchObject({
            kind: "ValidationFailed",
            issues: [{ path: ["reviewers", 1] }],
        });
    });
    it.each([
        { errorName: "ActionTypeNotFound", parameters: { parameterId: "project" } },
        { errorName: "ActionParameterObjectNotFound", parameters: { parameterId: "hidden" } },
        { errorName: "ObjectNotFound", parameters: { objectType: "Secret", primaryKey: "gone" } },
        {},
    ])("does not guess a field from unrelated or insufficient not-found evidence: %j", (error) => {
        expect(normalize({ statusCode: 404, ...error })).toMatchObject({
            kind: "NotFound",
            message: "Resource not found.",
            issues: undefined,
        });
    });
});
