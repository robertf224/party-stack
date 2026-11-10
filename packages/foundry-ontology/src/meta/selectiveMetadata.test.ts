import { ObjectTypesV2, OntologiesV2, OntologyValueTypes } from "@osdk/foundry.ontologies";
import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { and, eq, field, inArray, like, or } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeFoundryMetadataBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { Predicate, Query } from "@party-stack/ontology-storage";

vi.mock("@osdk/foundry.ontologies", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.ontologies")>();
    return {
        ...original,
        OntologiesV2: { ...original.OntologiesV2, getFullMetadata: vi.fn() },
        ObjectTypesV2: {
            ...original.ObjectTypesV2,
            getByRidBatch: vi.fn(),
            getFullMetadataBatch: vi.fn(),
            list: vi.fn(),
            listOutgoingLinkTypes: vi.fn(),
            getOutgoingLinkTypesByObjectTypeRidBatch: vi.fn(),
        },
        OntologyValueTypes: { ...original.OntologyValueTypes, get: vi.fn(), list: vi.fn() },
    };
});

const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ontology",
    tokenProvider: async () => "token",
    fetch: globalThis.fetch,
};
const objectType = (name: string, displayName = name) => ({
    apiName: name,
    rid: `rid-${name}`,
    displayName,
    pluralDisplayName: `${name}s`,
    primaryKey: "id",
    titleProperty: "id",
    properties: {},
    icon: { type: "blueprint" as const, name: "cube", color: "#000000" },
    aliases: [],
    datasources: [],
    status: "ACTIVE" as const,
});
const objectMetadata = (name: string, displayName = name) => ({
    objectType: objectType(name, displayName),
    linkTypes: [],
    implementsInterfaces: [],
    implementsInterfaces2: {},
    sharedPropertyTypeMapping: {},
});
const valueType = (name: string) => ({
    apiName: name,
    rid: `rid-${name}`,
    displayName: name,
    fieldType: { type: "string" as const },
    constraints: [],
    version: "1",
});
const side = (name: string, other: string, rid = "link", foreignKey?: string) => ({
    apiName: name,
    displayName: name,
    objectTypeApiName: other,
    linkTypeRid: rid,
    cardinality: "ONE" as const,
    status: "ACTIVE" as const,
    foreignKeyPropertyApiName: foreignKey,
});

function load(objectTypeName: string, query: Query = {}) {
    const requested = objectSubset(objectTypeName, query);
    return Effect.runPromise(
        Effect.gen(function* () {
            const raw = yield* makeFoundryMetadataBackend({ client }).loadSubset(requested);
            const resolved = yield* resolveSubsetSnapshot(metaOntology, requested, raw);
            return { ...resolved, raw, requested };
        })
    );
}

beforeEach(() => vi.resetAllMocks());

describe("native selective Foundry metadata", () => {
    it("batches exact names without claiming the entire collection is complete", async () => {
        vi.mocked(ObjectTypesV2.getFullMetadataBatch).mockResolvedValue({
            data: [objectMetadata("A"), objectMetadata("B")],
        });
        const result = await load("ObjectType", { where: inArray(field("name"), ["A", "A", "B"]) });
        expect(result.snapshot.rows.map(({ key }) => key)).toEqual(["A", "B"]);
        expect(result.raw.fulfilledSubset?.where).toBeDefined();
        expect(result.fulfilled.query?.where).toEqual(inArray(field("name"), ["A", "A", "B"]));
        expect(ObjectTypesV2.getFullMetadataBatch).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "ontology",
            { requests: [{ objectType: "A" }, { objectType: "B" }], includeLinkTypes: false },
            { preview: true }
        );
        expect(ObjectTypesV2.list).not.toHaveBeenCalled();
        expect(OntologiesV2.getFullMetadata).not.toHaveBeenCalled();
    });

    it("splits exact RID batches at 100 and preserves RID versus name identity", async () => {
        vi.mocked(ObjectTypesV2.getByRidBatch).mockImplementation(async (_client, _ontology, body) => ({
            data: body.requests.map(({ objectTypeRid }) => objectType(objectTypeRid.slice(4))),
        }));
        const ids = Array.from({ length: 205 }, (_, index) => `rid-Type${index}`);
        const result = await load("ObjectType", { where: inArray(field("id"), [...ids, ids[0]!]) });
        expect(result.snapshot.rows).toHaveLength(205);
        expect(result.snapshot.rows[0]).toMatchObject({ key: "Type0", value: { id: "rid-Type0" } });
        expect(
            vi.mocked(ObjectTypesV2.getByRidBatch).mock.calls.map((call) => call[2].requests.length)
        ).toEqual([100, 100, 5]);
        expect(ObjectTypesV2.getFullMetadataBatch).not.toHaveBeenCalled();
        expect(ObjectTypesV2.list).not.toHaveBeenCalled();
        expect(OntologiesV2.getFullMetadata).not.toHaveBeenCalled();
    });

    it("keeps residual predicates, full ordering and limit after bounded acquisition", async () => {
        vi.mocked(ObjectTypesV2.getFullMetadataBatch).mockResolvedValue({
            data: [
                objectMetadata("A", "Keep A"),
                objectMetadata("B", "Other"),
                objectMetadata("C", "Keep C"),
            ],
        });
        const result = await load("ObjectType", {
            where: and(inArray(field("name"), ["A", "B", "C"]), like(field("displayName"), "Keep%")),
            orderBy: [{ field: field("name"), direction: "desc" }],
            limit: 1,
        });
        expect(result.raw.fetchedRows).toBe(3);
        expect(result.snapshot.rows.map(({ key }) => key)).toEqual(["C"]);
        expect(ObjectTypesV2.getFullMetadataBatch).toHaveBeenCalledWith(
            expect.anything(),
            "ontology",
            { requests: ["A", "B", "C"].map((objectType) => ({ objectType })), includeLinkTypes: false },
            { preview: true }
        );
        expect(ObjectTypesV2.list).not.toHaveBeenCalled();
    });

    it("does not partially push an unsupported OR and paginates the safe fallback", async () => {
        vi.mocked(ObjectTypesV2.list)
            .mockResolvedValueOnce({ data: [objectType("A")], nextPageToken: "next" })
            .mockResolvedValueOnce({ data: [objectType("B"), objectType("C")] });
        const result = await load("ObjectType", {
            where: or(eq(field("name"), "A"), like(field("name"), "B%")),
        });
        expect(result.snapshot.rows.map(({ key }) => key)).toEqual(["A", "B"]);
        expect(ObjectTypesV2.list).toHaveBeenNthCalledWith(1, expect.anything(), "ontology", {
            pageSize: 100,
            pageToken: undefined,
        });
        expect(ObjectTypesV2.list).toHaveBeenNthCalledWith(2, expect.anything(), "ontology", {
            pageSize: 100,
            pageToken: "next",
        });
        expect(ObjectTypesV2.getFullMetadataBatch).not.toHaveBeenCalled();
        expect(ObjectTypesV2.getByRidBatch).not.toHaveBeenCalled();
        expect(OntologiesV2.getFullMetadata).not.toHaveBeenCalled();
    });

    it.each(["ObjectType", "ValueType", "LinkType"])(
        "performs no provider IO for an empty %s selection and certifies only that selection",
        async (type) => {
            const path = type === "LinkType" ? field("source", "objectType") : field("name");
            const result = await load(type, { where: inArray(path, []) });
            expect(result.snapshot.rows).toEqual([]);
            expect(result.raw.fulfilledSubset).toEqual(result.requested);
            expect(ObjectTypesV2.getFullMetadataBatch).not.toHaveBeenCalled();
            expect(ObjectTypesV2.list).not.toHaveBeenCalled();
            expect(ObjectTypesV2.listOutgoingLinkTypes).not.toHaveBeenCalled();
            expect(OntologyValueTypes.get).not.toHaveBeenCalled();
            expect(OntologyValueTypes.list).not.toHaveBeenCalled();
            expect(OntologiesV2.getFullMetadata).not.toHaveBeenCalled();
        }
    );

    it.each(["source", "target", "or", "and"])(
        "resolves both physical sides of a %s endpoint query without an ontology scan",
        async (kind) => {
            vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockImplementation(
                async (_client, _ontology, name, options) => {
                    if (name === "Post")
                        return options?.pageToken
                            ? { data: [] }
                            : { data: [side("author", "Author", "link", "authorId")], nextPageToken: "next" };
                    return { data: [{ ...side("posts", "Post"), cardinality: "MANY" }] };
                }
            );
            vi.mocked(ObjectTypesV2.getFullMetadataBatch).mockImplementation(
                async (_client, _ontology, body) => ({
                    data: body.requests.map(({ objectType }) => objectMetadata(objectType)),
                })
            );
            vi.mocked(ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch).mockImplementation(
                async (_client, _ontology, body) => ({
                    data: Object.fromEntries(
                        body.requests.map(({ objectTypeRid }) => [
                            objectTypeRid,
                            objectTypeRid === "rid-Author"
                                ? [{ ...side("posts", "Post"), cardinality: "MANY" }]
                                : [side("author", "Author", "link", "authorId")],
                        ])
                    ),
                })
            );
            const source = eq(field("source", "objectType"), "Post");
            const target = eq(field("target", "objectType"), "Author");
            const where =
                kind === "source"
                    ? source
                    : kind === "target"
                      ? target
                      : kind === "or"
                        ? or(source, target)
                        : and(source, target);
            const result = await load("LinkType", { where });
            expect(result.snapshot.rows).toEqual([
                expect.objectContaining({
                    value: expect.objectContaining({
                        id: "link",
                        source: expect.objectContaining({ objectType: "Post", name: "posts" }),
                        target: expect.objectContaining({ objectType: "Author", name: "author" }),
                        foreignKey: "authorId",
                        cardinality: "many",
                    }),
                }),
            ]);
            expect(result.raw.fulfilledSubset?.where).toBeDefined();
            expect(ObjectTypesV2.getFullMetadataBatch).toHaveBeenCalledTimes(kind === "or" ? 0 : 1);
            const inverseCalls = vi.mocked(ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch).mock.calls;
            expect(
                inverseCalls.map(([, ontology, body, settings]) => ({ ontology, body, settings }))
            ).toEqual(
                kind === "or"
                    ? []
                    : [
                          {
                              ontology: "ontology",
                              body: {
                                  requests: [
                                      { objectTypeRid: kind === "target" ? "rid-Post" : "rid-Author" },
                                  ],
                                  filterLinkTypeRids: ["link"],
                              },
                              settings: { preview: true },
                          },
                      ]
            );
            expect(ObjectTypesV2.list).not.toHaveBeenCalled();
            expect(OntologiesV2.getFullMetadata).not.toHaveBeenCalled();
        }
    );

    it("deduplicates an endpoint union and batches neighbor and inverse lookups at 100", async () => {
        const names = Array.from({ length: 205 }, (_, index) => `Neighbor${index}`);
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockResolvedValue({
            data: names.map((name) => side(name, name, `link-${name}`, `fk-${name}`)),
        });
        vi.mocked(ObjectTypesV2.getFullMetadataBatch).mockImplementation(
            async (_client, _ontology, body) => ({
                data: body.requests.map(({ objectType }) => objectMetadata(objectType)),
            })
        );
        vi.mocked(ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch).mockImplementation(
            async (_client, _ontology, body) => ({
                data: Object.fromEntries(
                    body.requests.map(({ objectTypeRid }) => [
                        objectTypeRid,
                        [{ ...side("posts", "Post", `link-${objectTypeRid.slice(4)}`), cardinality: "MANY" }],
                    ])
                ),
            })
        );
        const result = await load("LinkType", {
            where: or(eq(field("source", "objectType"), "Post"), eq(field("target", "objectType"), "Post")),
        });
        expect(result.snapshot.rows).toHaveLength(205);
        expect(ObjectTypesV2.listOutgoingLinkTypes).toHaveBeenCalledOnce();
        expect(
            vi.mocked(ObjectTypesV2.getFullMetadataBatch).mock.calls.map((call) => call[2].requests.length)
        ).toEqual([100, 100, 5]);
        expect(
            vi
                .mocked(ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch)
                .mock.calls.map((call) => call[2].requests.length)
        ).toEqual([100, 100, 5]);
    });

    it("omits links with an inaccessible opposite endpoint", async () => {
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockResolvedValue({
            data: [side("author", "Author", "link", "authorId")],
        });
        vi.mocked(ObjectTypesV2.getFullMetadataBatch).mockResolvedValue({ data: [] });
        expect(
            (await load("LinkType", { where: eq(field("source", "objectType"), "Post") })).snapshot.rows
        ).toEqual([]);
        expect(ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch).not.toHaveBeenCalled();
    });

    it("normalizes self links once without resolving their own endpoint again", async () => {
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockResolvedValue({
            data: [
                side("manager", "Employee", "self", "managerId"),
                { ...side("reports", "Employee", "self"), cardinality: "MANY" },
            ],
        });
        const result = await load("LinkType", { where: eq(field("source", "objectType"), "Employee") });
        expect(result.snapshot.rows).toHaveLength(1);
        expect(result.snapshot.rows[0]?.value).toMatchObject({
            source: { name: "reports" },
            target: { name: "manager" },
            cardinality: "many",
        });
        expect(ObjectTypesV2.listOutgoingLinkTypes).toHaveBeenCalledOnce();
        expect(ObjectTypesV2.getFullMetadataBatch).not.toHaveBeenCalled();
        expect(ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch).not.toHaveBeenCalled();
    });

    it("loads exact value names independently and lists unbounded value types", async () => {
        vi.mocked(OntologyValueTypes.get).mockImplementation(async (_client, _ontology, name) =>
            valueType(name)
        );
        expect(
            (
                await load("ValueType", { where: inArray(field("name"), ["Email", "Email", "Phone"]) })
            ).snapshot.rows.map(({ key }) => key)
        ).toEqual(["Email", "Phone"]);
        expect(OntologyValueTypes.get).toHaveBeenCalledTimes(2);
        expect(OntologyValueTypes.list).not.toHaveBeenCalled();
        vi.mocked(OntologyValueTypes.list).mockResolvedValue({
            data: [valueType("Email"), valueType("Phone")],
        });
        expect((await load("ValueType")).snapshot.rows.map(({ key }) => key)).toEqual(["Email", "Phone"]);
        expect(OntologyValueTypes.list).toHaveBeenCalledExactlyOnceWith(expect.anything(), "ontology", {
            preview: true,
        });
        expect(OntologiesV2.getFullMetadata).not.toHaveBeenCalled();
    });

    it.each(["ValueType", "LinkType"])("treats only a direct %s 404 as absence", async (type) => {
        vi.mocked(OntologyValueTypes.get).mockRejectedValue({ statusCode: 404 });
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockRejectedValue({ statusCode: 404 });
        const path = type === "ValueType" ? field("name") : field("target", "objectType");
        expect((await load(type, { where: eq(path, "Missing") })).snapshot.rows).toEqual([]);
        expect(OntologyValueTypes.list).not.toHaveBeenCalled();
        expect(ObjectTypesV2.list).not.toHaveBeenCalled();
    });

    it("fails a missing continuation page instead of certifying a partial link neighborhood", async () => {
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes)
            .mockResolvedValueOnce({
                data: [side("author", "Author", "link", "authorId")],
                nextPageToken: "next",
            })
            .mockRejectedValueOnce({ statusCode: 404 });
        const result = await Effect.runPromise(
            Effect.result(
                makeFoundryMetadataBackend({ client }).loadSubset(
                    objectSubset("LinkType", { where: eq(field("source", "objectType"), "Post") })
                )
            )
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound", retryable: false } });
        expect(ObjectTypesV2.listOutgoingLinkTypes).toHaveBeenCalledTimes(2);
        expect(ObjectTypesV2.getFullMetadataBatch).not.toHaveBeenCalled();
    });

    it("reacquires provider metadata for a later load on the same backend", async () => {
        const backend = makeFoundryMetadataBackend({ client });
        const requested = objectSubset("LinkType", { where: eq(field("source", "objectType"), "Employee") });
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockResolvedValue({
            data: [
                side("manager", "Employee", "self", "managerId"),
                { ...side("reports", "Employee", "self"), cardinality: "MANY" },
            ],
        });
        expect((await Effect.runPromise(backend.loadSubset(requested))).rows).toHaveLength(1);
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockResolvedValue({ data: [] });
        expect((await Effect.runPromise(backend.loadSubset(requested))).rows).toEqual([]);
        expect(ObjectTypesV2.listOutgoingLinkTypes).toHaveBeenCalledTimes(2);
    });

    it.each([
        [401, "Unauthenticated", false],
        [500, "Unavailable", true],
    ] as const)("preserves direct lookup HTTP %s failures", async (statusCode, kind, retryable) => {
        vi.mocked(OntologyValueTypes.get).mockRejectedValue({ statusCode });
        vi.mocked(ObjectTypesV2.listOutgoingLinkTypes).mockRejectedValue({ statusCode });
        for (const [type, where] of [
            ["ValueType", eq(field("name"), "Email")],
            ["LinkType", eq(field("source", "objectType"), "Post")],
        ] satisfies [string, Predicate][]) {
            const result = await Effect.runPromise(
                Effect.result(
                    makeFoundryMetadataBackend({ client }).loadSubset(objectSubset(type, { where }))
                )
            );
            expect(result).toMatchObject({ _tag: "Failure", failure: { kind, retryable } });
        }
    });

    it("does not turn a request-level batch 404 into an empty successful collection", async () => {
        vi.mocked(ObjectTypesV2.getFullMetadataBatch).mockRejectedValue({ statusCode: 404 });
        const result = await Effect.runPromise(
            Effect.result(
                makeFoundryMetadataBackend({ client }).loadSubset(
                    objectSubset("ObjectType", { where: eq(field("name"), "Missing") })
                )
            )
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound", retryable: false } });
    });
});
