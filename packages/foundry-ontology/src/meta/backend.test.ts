import { pull } from "@party-stack/ontology-backend/meta";
import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import metaOntology from "@party-stack/ontology-spec/meta";
import { eq, field, inArray } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { makeFoundryMetadataBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";

const mocks = vi.hoisted(() => ({ load: vi.fn(), links: vi.fn(), values: vi.fn() }));
vi.mock("./loadEntities.js", () => ({
    loadFoundryMetaObjectTypes: mocks.load,
    loadFoundryMetaLinkTypes: mocks.links,
    loadFoundryMetaValueTypes: mocks.values,
}));
const backend = () =>
    makeFoundryMetadataBackend({
        client: { baseUrl: "https://foundry.example/", ontologyRid: "ontology" } as OntologyClient,
    });
beforeEach(() => {
    vi.resetAllMocks();
    mocks.load.mockResolvedValue([]);
    mocks.links.mockResolvedValue([]);
    mocks.values.mockResolvedValue([]);
});

test("pull declares the known Foundry current-user context without an app transform", async () => {
    const result = await Effect.runPromise(
        pull(backend(), {
            objectTypeNames: [],
            actionTypeNames: [],
            queryFunctionTypeNames: [],
        })
    );
    expect(result.context).toEqual({
        type: o.struct({ fields: [{ name: "userId", displayName: "User ID", type: o.string({}) }] }),
        partition: [["userId"]],
    });
});

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
    mocks.load.mockResolvedValue([{ name: "Issue" }, { name: "Project" }]);
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
    mocks.load.mockResolvedValue([{ displayName: "Missing name" }]);
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
