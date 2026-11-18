import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import metaOntology from "@party-stack/ontology-spec/meta";
import { and, eq, field, ilike, like, or } from "@party-stack/ontology-storage";
import { applyQuery } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toOntologyActionTypeName } from "../utils/actionTypeName.js";
import { makeFoundryMetadataBackend } from "./backend.js";
import { actionTypeSearchFields, actionTypeSearchQuery, planActionTypeWindow } from "./searchActionTypes.js";
import type {
    ActionTypeSearchJsonQueryV2,
    ActionTypeV2,
    SearchActionTypesRequestV2,
} from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { Query } from "@party-stack/ontology-storage";

const mocks = vi.hoisted(() => ({
    bulkLoadOntologyEntities: vi.fn(),
    getFullMetadataBatch: vi.fn(),
    search: vi.fn(),
}));
vi.mock("@osdk/client.unstable", () => ({ bulkLoadOntologyEntities: mocks.bulkLoadOntologyEntities }));
vi.mock("@osdk/foundry.ontologies", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.ontologies")>();
    return {
        ...original,
        ActionTypesV2: { ...original.ActionTypesV2, search: mocks.search },
        ActionTypesFullMetadata: {
            ...original.ActionTypesFullMetadata,
            getFullMetadataBatch: mocks.getFullMetadataBatch,
        },
    };
});

const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ontology",
    tokenProvider: async () => "token",
    fetch: globalThis.fetch,
};
const actionType = (apiName: string, displayName: string): ActionTypeV2 => ({
    apiName,
    displayName,
    status: "ACTIVE",
    parameters: {},
    rid: `ri.actions.main.action-type.${apiName}`,
    operations: [{ type: "createObject", objectTypeApiName: "Task" }],
});

/** A fake Foundry search: case-insensitive substring `contains`, ordered by `compare`. */
function foundry(
    actionTypes: ActionTypeV2[],
    compare: (left: string, right: string) => number = (left, right) =>
        left < right ? -1 : left > right ? 1 : 0
) {
    const text = (value: string, predicate: { type: string; value: string }) =>
        predicate.type === "exact"
            ? value === predicate.value
            : value.toLowerCase().includes(predicate.value.toLowerCase());
    const matches = (value: ActionTypeV2, query?: ActionTypeSearchJsonQueryV2): boolean => {
        if (!query) return true;
        switch (query.type) {
            case "and":
                return query.value.every((child) => matches(value, child));
            case "or":
                return query.value.some((child) => matches(value, child));
            case "actionTypeRid":
                return value.rid === query.value;
            case "actionTypeApiName":
                return text(value.apiName, query.value);
            case "actionTypeDisplayName":
                return text(value.displayName ?? value.apiName, query.value);
            default:
                throw new Error(`Unexpected query ${query.type}`);
        }
    };
    mocks.search.mockImplementation(
        async (_client: unknown, _ontology: string, request: SearchActionTypesRequestV2) => {
            const all = actionTypes.filter((value) => matches(value, request.where));
            if (request.orderBy) {
                const sign = request.orderBy.direction === "desc" ? -1 : 1;
                // Foundry's tie order is its own: reverse API name here, never the engine's.
                all.sort(
                    (left, right) =>
                        sign * compare(left.displayName!, right.displayName!) ||
                        (left.apiName < right.apiName ? 1 : -1)
                );
            }
            const start = Number(request.pageToken ?? 0);
            const end = start + (request.pageSize ?? 100);
            return {
                data: all.slice(start, end),
                nextPageToken: end < all.length ? String(end) : undefined,
                totalCount: String(all.length),
            };
        }
    );
    mocks.getFullMetadataBatch.mockImplementation(
        async (_client: unknown, _ontology: string, body: { requests: { actionType: string }[] }) => ({
            data: body.requests.map((request) => ({
                actionType: actionTypes.find((value) => value.apiName === request.actionType)!,
                fullLogicRules: [],
            })),
        })
    );
}

function load(query: Query) {
    const requested = objectSubset("ActionType", query);
    const backend = makeFoundryMetadataBackend({ client });
    return Effect.runPromise(
        Effect.gen(function* () {
            const raw = yield* backend.loadSubset(requested);
            const resolved = yield* resolveSubsetSnapshot(metaOntology, requested, raw);
            return { ...resolved, raw, backend };
        })
    );
}

/** The engine's answer over the whole ontology. */
const oracle = (actionTypes: ActionTypeV2[], query: Query) =>
    applyQuery(
        actionTypes.map((value) => ({
            key: toOntologyActionTypeName(value.apiName),
            value: actionTypeSearchFields(value),
        })),
        query
    ).map((row) => row.key);

const searchRequests = () => mocks.search.mock.calls.map((call) => call[2] as SearchActionTypesRequestV2);
const keys = (rows: readonly { key: unknown }[]) => rows.map((row) => row.key);

beforeEach(() => {
    vi.resetAllMocks();
    mocks.bulkLoadOntologyEntities.mockResolvedValue({ actionTypes: [], objectTypes: [] });
});

describe("windowed Foundry action type search", () => {
    const pad = (index: number) => String(index).padStart(4, "0");
    const large = Array.from({ length: 5000 }, (_, index) =>
        actionType(`task-${pad(index)}`, `Task ${pad(index)}`)
    );
    const search = (term: string) => or(ilike(field("name"), term), ilike(field("displayName"), term));

    it("loads metadata only for the leading window of a large ontology", async () => {
        foundry(large);
        const query: Query = {
            where: search("%task%"),
            orderBy: [{ field: field("displayName"), direction: "asc" }],
            limit: 200,
        };
        const result = await load(query);

        expect(keys(result.snapshot.rows)).toEqual(oracle(large, query));
        expect(mocks.search.mock.calls.length).toBeLessThanOrEqual(3);
        expect(searchRequests()[0]).toMatchObject({
            orderBy: { field: "actionTypeDisplayName", direction: "asc" },
            fuzziness: { type: "off" },
            where: {
                type: "or",
                value: [
                    { type: "actionTypeApiName", value: { type: "contains", value: "task" } },
                    { type: "actionTypeDisplayName", value: { type: "contains", value: "task" } },
                ],
            },
        });
        expect(mocks.getFullMetadataBatch).toHaveBeenCalledTimes(2);
        expect(mocks.bulkLoadOntologyEntities).toHaveBeenCalledTimes(2);
        expect(result.raw.rows.length).toBeLessThanOrEqual(201);
    });

    it("certifies the leading window so later pages of the same search are covered", async () => {
        foundry(large);
        const orderBy = [{ field: field("displayName"), direction: "desc" as const }];
        const query: Query = { where: search("%00%"), orderBy, offset: 20, limit: 10 };
        const result = await load(query);

        expect(keys(result.snapshot.rows)).toEqual(oracle(large, query));
        expect(result.fulfilled.query).toMatchObject({ orderBy, limit: 30 });
        expect(result.fulfilled.query?.offset).toBeUndefined();
        // The same snapshot answers any page inside the window, and nothing past it.
        const page = (offset: number, limit: number) =>
            Effect.runPromise(
                Effect.result(
                    resolveSubsetSnapshot(
                        metaOntology,
                        objectSubset("ActionType", { ...query, offset, limit }),
                        result.raw
                    )
                )
            );
        const first = await page(0, 30);
        expect(first._tag === "Success" ? keys(first.success.snapshot.rows) : first).toEqual(
            oracle(large, { ...query, offset: 0, limit: 30 })
        );
        expect((await page(25, 5))._tag).toBe("Success");
        expect((await page(20, 11))._tag).toBe("Failure");
        expect(searchRequests()[0]?.orderBy).toEqual({ field: "actionTypeDisplayName", direction: "desc" });
    });

    it("rechecks the filter locally and reads past display name ties at the boundary", async () => {
        const tied = [
            ...["e", "a", "d", "c", "b"].map((name) => actionType(`same-${name}`, "Same")),
            actionType("alpha", "Alpha"),
            actionType("zulu", "Zulu"),
            actionType("same-but-other", "Same thing"),
        ];
        foundry(tied);
        const query: Query = {
            where: and(ilike(field("displayName"), "%a%"), like(field("name"), "same%")),
            orderBy: [{ field: field("displayName") }],
            limit: 2,
        };
        const result = await load(query);
        expect(keys(result.snapshot.rows)).toEqual(oracle(tied, query));
        expect(keys(result.snapshot.rows)).toEqual(["sameA", "sameB"]);
    });

    it("falls back to the full scan when Foundry orders display names differently", async () => {
        const mixed = ["apple", "Banana", "cherry", "Date"].map((name) =>
            actionType(name.toLowerCase(), name)
        );
        foundry(mixed, (left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const query: Query = { orderBy: [{ field: field("displayName") }], limit: 2 };
        const requested = objectSubset("ActionType", query);
        const backend = makeFoundryMetadataBackend({ client });
        const run = () =>
            Effect.runPromise(
                backend
                    .loadSubset(requested)
                    .pipe(Effect.flatMap((raw) => resolveSubsetSnapshot(metaOntology, requested, raw)))
            );

        const first = await run();
        expect(keys(first.snapshot.rows)).toEqual(oracle(mixed, query));
        expect(first.fulfilled.query?.limit).toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();

        mocks.search.mockClear();
        await run();
        expect(searchRequests().every((request) => request.orderBy === undefined)).toBe(true);
        warn.mockRestore();
    });

    it("keeps unordered and non-displayName windows on the full scan", async () => {
        foundry(large.slice(0, 250));
        const query: Query = { where: ilike(field("displayName"), "%task%"), limit: 5 };
        const result = await load(query);
        expect(keys(result.snapshot.rows)).toEqual(oracle(large.slice(0, 250), query));
        expect(searchRequests().map((request) => request.orderBy)).toEqual([undefined, undefined, undefined]);
        expect(result.fulfilled.query?.where).toEqual(query.where);
        expect(result.fulfilled.query?.limit).toBeUndefined();
        expect(result.raw.fetchedRows).toBe(250);

        expect(planActionTypeWindow({ orderBy: [{ field: field("name") }], limit: 1 })).toBeUndefined();
        expect(
            planActionTypeWindow({
                where: eq(field("description"), "x"),
                orderBy: [{ field: field("displayName") }],
                limit: 1,
            })
        ).toBeUndefined();
        expect(
            planActionTypeWindow({
                orderBy: [{ field: field("displayName") }],
                limit: 1,
                after: { values: ["A"], key: "a" },
            })
        ).toBeUndefined();
    });

    it("does not call Foundry for an empty window", async () => {
        foundry(large);
        const result = await load({ orderBy: [{ field: field("displayName") }], limit: 0 });
        expect(result.snapshot.rows).toEqual([]);
        expect(mocks.search).not.toHaveBeenCalled();
    });
});

describe("action type search prefilter", () => {
    it("pushes the literal runs of patterns with wildcards and backslashes", () => {
        // Storage LIKE treats `\` as a literal, so `\_` is a backslash then any character.
        expect(actionTypeSearchQuery(ilike(field("displayName"), "%create\\_task%"))).toEqual({
            type: "and",
            value: [
                { type: "actionTypeDisplayName", value: { type: "contains", value: "create" } },
                { type: "actionTypeDisplayName", value: { type: "contains", value: "task" } },
            ],
        });
        expect(actionTypeSearchQuery(like(field("name"), "create_my%Task"))).toEqual({
            type: "and",
            value: [
                { type: "actionTypeApiName", value: { type: "contains", value: "create" } },
                { type: "actionTypeApiName", value: { type: "contains", value: "my" } },
                { type: "actionTypeApiName", value: { type: "contains", value: "task" } },
            ],
        });
        expect(actionTypeSearchQuery(ilike(field("displayName"), "%\\%"))).toBeUndefined();
        expect(
            actionTypeSearchQuery(or(ilike(field("displayName"), "%a%"), ilike(field("name"), "%")))
        ).toBeUndefined();
    });

    it("finds escaped-pattern matches through the windowed path", async () => {
        const values = [actionType("a", "Create\\_task"), actionType("b", "Create task")];
        foundry(values);
        const query: Query = {
            where: ilike(field("displayName"), "%create\\_task%"),
            orderBy: [{ field: field("displayName") }],
            limit: 10,
        };
        const result = await load(query);
        expect(keys(result.snapshot.rows)).toEqual(oracle(values, query));
        expect(keys(result.snapshot.rows)).toEqual(["a"]);
    });
});
