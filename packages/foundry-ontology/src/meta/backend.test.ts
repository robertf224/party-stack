import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { eq, field, inArray } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { makeFoundryMetadataBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./loadEntities.js", () => ({ loadFoundryMetaOntology: mocks.load }));
const backend = () =>
    makeFoundryMetadataBackend({
        client: { baseUrl: "https://foundry.example/", ontologyRid: "ontology" } as OntologyClient,
    });
beforeEach(() => vi.resetAllMocks());

test.each([
    [401, "Unauthenticated", false],
    [403, "Forbidden", false],
    [429, "RateLimited", true],
] as const)("metadata preserves HTTP %s semantics", async (statusCode, kind, retryable) => {
    mocks.load.mockRejectedValue({ statusCode });
    expect(await Effect.runPromise(Effect.result(loadSubset(objectSubset("ObjectType"))))).toMatchObject({
        _tag: "Failure",
        failure: { kind, retryable },
    });
});

test("metadata filters provider candidates before certifying the requested subset", async () => {
    mocks.load.mockResolvedValue({ objectTypes: [{ name: "Issue" }, { name: "Project" }] });
    const snapshot = await Effect.runPromise(
        loadSubset(objectSubset("ObjectType", { where: eq(field("name"), "Issue") }))
    );
    expect(snapshot).toMatchObject({
        complete: true,
        fetchedRows: 2,
        rows: [{ key: "Issue", value: { name: "Issue" } }],
    });
});

test("malformed metadata identities are nonretryable response failures", async () => {
    mocks.load.mockResolvedValue({ objectTypes: [{ displayName: "Missing name" }] });
    expect(await Effect.runPromise(Effect.result(loadSubset(objectSubset("ObjectType"))))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidResponse", retryable: false },
    });
});

function loadSubset(subset: import("@party-stack/ontology-spec/query").ObjectSubset) {
    return backend()
        .loadSubset(subset)
        .pipe(
            Effect.flatMap((snapshot) => resolveSubsetSnapshot(metaOntology, subset, snapshot)),
            Effect.map((result) => result.snapshot)
        );
}

test("an empty name selection does not certify an empty complete metadata collection", async () => {
    const requested = objectSubset("ObjectType", { where: inArray(field("name"), []) });
    const snapshot = await Effect.runPromise(backend().loadSubset(requested));
    expect(snapshot.fulfilledSubset).toEqual(requested);
    expect(snapshot.rows).toEqual([]);
    expect(mocks.load).not.toHaveBeenCalled();
});
