import { and, eq, field, ilike, inArray, or } from "@party-stack/ontology-storage";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { loadUserSubset } from "./loadUserSubset.js";
import type { Client } from "@party-stack/foundry-client";
import type { Lens } from "@party-stack/ontology-spec";

const mocks = vi.hoisted(() => ({ list: vi.fn(), search: vi.fn(), getBatch: vi.fn() }));
vi.mock("@osdk/foundry.admin", () => ({ Users: mocks }));
const client = { fetch: vi.fn() } as unknown as Client;
const identity: Lens = { operations: [] };
const signal = () => new AbortController().signal;
const user = (id: string, givenName = id) => ({ id, username: id, givenName });
beforeEach(() => vi.resetAllMocks());

test("unfiltered users use the real list endpoint and follow every page", async () => {
    mocks.list
        .mockResolvedValueOnce({ data: [user("a")], nextPageToken: "next" })
        .mockResolvedValueOnce({ data: [user("b")] });
    const result = await loadUserSubset(client, identity, {}, signal());
    expect(result.rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(result.fetchedRows).toBe(2);
    expect(result.complete).toBe(true);
    expect(mocks.list.mock.calls.map((call) => call[1])).toEqual([
        { pageToken: undefined },
        { pageToken: "next" },
    ]);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(JSON.parse(result.pushdown!.native!.text)).toEqual({ operation: "Users.list" });
});

test("ID batches deduplicate, respect the 500-ID API limit, and finish sorting/pagination locally", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `id-${String(index).padStart(3, "0")}`);
    mocks.getBatch.mockImplementation(async (_client, batch: { userId: string }[]) => ({
        data: Object.fromEntries(
            batch.filter(({ userId }) => userId !== "missing").map(({ userId }) => [userId, user(userId)])
        ),
    }));
    const result = await loadUserSubset(
        client,
        identity,
        {
            where: inArray(field("id"), [...ids, ids[0]!, "missing"]),
            orderBy: [{ field: field("id"), direction: "desc" }],
            offset: 1,
            limit: 2,
        },
        signal()
    );
    expect(mocks.getBatch.mock.calls.map((call) => call[1].length)).toEqual([500, 2]);
    expect(result.rows.map((row) => row.key)).toEqual(["id-499", "id-498"]);
    expect(result.fetchedRows).toBe(501);
    expect(result.pushdown).toMatchObject({
        predicates: [{ path: [], execution: "source" }],
        sorting: "adapter",
        pagination: "adapter",
    });
});

test("name-prefix OR queries use one broad Admin search and check the requested fields afterward", async () => {
    mocks.search.mockResolvedValue({
        data: [
            user("a", "Robert"),
            { ...user("b", "Alex"), familyName: "Robinson" },
            { ...user("robert", "Alex"), familyName: "Smith" },
        ],
    });
    const result = await loadUserSubset(
        client,
        identity,
        { where: or(ilike(field("givenName"), "ro%"), ilike(field("familyName"), "ro%")) },
        signal()
    );
    expect(mocks.search).toHaveBeenCalledWith(expect.anything(), {
        where: { type: "queryString", value: "ro" },
        pageToken: undefined,
    });
    expect(result.rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(result.pushdown?.predicates.map((term) => term.execution)).toEqual(["candidate", "candidate"]);
});

test("an unsupported OR branch lists users rather than losing matches to an ID-only fetch", async () => {
    mocks.list.mockResolvedValue({ data: [user("a"), { ...user("b"), email: "b@example.com" }] });
    const result = await loadUserSubset(
        client,
        identity,
        { where: or(eq(field("id"), "a"), eq(field("email"), "b@example.com")) },
        signal()
    );
    expect(result.rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(mocks.getBatch).not.toHaveBeenCalled();
    expect(result.pushdown?.predicates.map((term) => term.execution)).toEqual(["adapter", "adapter"]);
});

test("an AND can narrow by ID while retaining all remaining conditions", async () => {
    mocks.getBatch.mockResolvedValue({ data: { a: user("a", "Alex") } });
    const result = await loadUserSubset(
        client,
        identity,
        { where: and(eq(field("id"), "a"), eq(field("givenName"), "Robert")) },
        signal()
    );
    expect(result.rows).toEqual([]);
    expect(result.pushdown?.predicates.map((term) => term.execution)).toEqual(["source", "adapter"]);
});

test("ID lookup follows a renamed ID lens and preserves the projected key", async () => {
    const lens: Lens = { operations: [{ kind: "move", value: { from: ["id"], to: ["userId"] } }] };
    mocks.getBatch.mockResolvedValue({ data: { a: user("a") } });
    const result = await loadUserSubset(client, lens, { where: eq(field("userId"), "a") }, signal());
    expect(result.rows).toMatchObject([{ key: "a", value: { userId: "a" } }]);
    expect(mocks.getBatch).toHaveBeenCalledWith(expect.anything(), [{ userId: "a" }]);
});

test("complex LIKE patterns fall back to listing without narrowing incorrectly", async () => {
    mocks.list.mockResolvedValue({ data: [user("a", "Robert")] });
    const result = await loadUserSubset(
        client,
        identity,
        { where: ilike(field("givenName"), "ro%rt%") },
        signal()
    );
    expect(result.rows).toHaveLength(1);
    expect(mocks.search).not.toHaveBeenCalled();
});

test("empty ID sets and zero limits perform no user API requests", async () => {
    expect(
        (await loadUserSubset(client, identity, { where: inArray(field("id"), []) }, signal())).rows
    ).toEqual([]);
    expect((await loadUserSubset(client, identity, { limit: 0 }, signal())).rows).toEqual([]);
    expect(mocks.getBatch).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
});

test("cancellation before a request or between pages stops further requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before fetch"));
    await expect(loadUserSubset(client, identity, {}, controller.signal)).rejects.toThrow(
        "Cancelled before fetch"
    );
    expect(mocks.list).not.toHaveBeenCalled();
    const during = new AbortController();
    mocks.list.mockImplementationOnce(async () => {
        during.abort(new Error("Cancelled between pages"));
        return { data: [], nextPageToken: "next" };
    });
    await expect(loadUserSubset(client, identity, {}, during.signal)).rejects.toThrow(
        "Cancelled between pages"
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
});
