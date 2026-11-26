import { expect, test } from "vite-plus/test";
import { classifyFoundryFailure } from "./foundryErrors.js";

const foundry = (errorName: string, errorCode: string, status: number) => ({
    errorName,
    errorCode,
    errorInstanceId: "instance",
    parameters: {},
    status,
});

test("errors about a changed ontology are schema mismatches", () => {
    for (const [name, code, status] of [
        ["PropertiesNotFound", "NOT_FOUND", 404],
        ["ObjectTypeNotFound", "NOT_FOUND", 404],
        ["LinkTypeNotFound", "NOT_FOUND", 404],
        ["ActionTypeNotFound", "NOT_FOUND", 404],
        ["ParametersNotFound", "INVALID_ARGUMENT", 400],
        ["InvalidPropertyType", "INVALID_ARGUMENT", 400],
        ["PropertiesNotSortable", "INVALID_ARGUMENT", 400],
    ] as const)
        expect(classifyFoundryFailure("foundry.sync", foundry(name, code, status))).toMatchObject({
            kind: "SchemaMismatch",
            retryable: false,
        });
    // Wrapped by the SDK.
    expect(
        classifyFoundryFailure("foundry.sync", { cause: foundry("PropertiesNotFound", "NOT_FOUND", 404) })
    ).toMatchObject({ kind: "SchemaMismatch" });
});

test("other errors keep their usual classification", () => {
    expect(classifyFoundryFailure("foundry.sync", foundry("ObjectNotFound", "NOT_FOUND", 404))).toMatchObject(
        {
            kind: "NotFound",
        }
    );
    // Not an unknown property: a property that needs an API name has none.
    expect(
        classifyFoundryFailure("foundry.sync", foundry("PropertyApiNameNotFound", "INVALID_ARGUMENT", 400))
    ).toMatchObject({ kind: "InvalidRequest" });
    expect(classifyFoundryFailure("foundry.sync", foundry("OntologySyncing", "CONFLICT", 409))).toMatchObject(
        {
            kind: "Unavailable",
            retryable: true,
            retryAfterMs: 5_000,
        }
    );
});
