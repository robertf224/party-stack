import { objectSubset } from "@party-stack/ontology-backend/subset";
import { eq, field } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { makeSalesforceMetadataBackend } from "./backend.js";
import type { SalesforceClient } from "@party-stack/salesforce-client";

const mocks = vi.hoisted(() => ({ describe: vi.fn() }));
vi.mock("./loadEntities.js", () => ({ describeSObjects: mocks.describe }));
const backend = () =>
    makeSalesforceMetadataBackend({
        client: { instanceUrl: "https://salesforce.example/" } as SalesforceClient,
        objectTypeNames: ["Account"],
    });
beforeEach(() => vi.resetAllMocks());

test.each([
    [401, "Unauthenticated", false],
    [403, "Forbidden", false],
    [429, "RateLimited", true],
] as const)("metadata preserves HTTP %s semantics", async (statusCode, kind, retryable) => {
    mocks.describe.mockRejectedValue({ statusCode });
    expect(
        await Effect.runPromise(Effect.result(backend().loadSubset(objectSubset("ObjectType"))))
    ).toMatchObject({ _tag: "Failure", failure: { kind, retryable } });
});

test("the ontology descriptor is a local singleton, not a link-type fetch", async () => {
    expect(await Effect.runPromise(backend().loadSubset(objectSubset("Ontology")))).toMatchObject({
        complete: true,
        rows: [{ key: "ontology", value: { id: "ontology" } }],
    });
    expect(
        await Effect.runPromise(
            backend().loadSubset(objectSubset("Ontology", { where: eq(field("id"), "missing") }))
        )
    ).toMatchObject({ complete: true, rows: [] });
    expect(mocks.describe).not.toHaveBeenCalled();
});
