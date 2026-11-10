import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import { field, literal, like, selectField, sub } from "@party-stack/ontology-spec/query";
import { eq, field as storageField } from "@party-stack/ontology-storage";
import { Deferred, Effect, Fiber } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { foundryPlatformOntology, makeFoundryPlatformBackend } from "./platform.js";
import type { ConnectionEgress } from "@party-stack/connect";

const ontology = (rid: string, displayName = rid) => ({
    rid,
    apiName: `api${rid}`,
    displayName,
    description: `Description for ${rid}`,
});
const query = {
    select: [
        sub("ontologies", {
            from: { source: { objectType: "Ontology" }, binding: "o" },
            where: like(field("o", "displayName"), literal("Keep%")),
            orderBy: [{ expression: field("o", "displayName"), direction: "desc" as const }],
            page: { offset: 1, limit: 1 },
            select: ["id", "apiName", "displayName"].map((name) => selectField(name, field("o", name))),
        }),
    ],
};
const egress = (fetch: ConnectionEgress["fetch"]): ConnectionEgress => ({
    fetch,
    createWebSocket: () => Effect.die("Platform inventory does not open a socket."),
});

test("platform inventory uses authenticated SDK egress and ordinary residual ordering/windowing", async () => {
    const fetch = vi.fn<ConnectionEgress["fetch"]>(() =>
        Effect.succeed(
            Response.json({
                data: [ontology("a", "Keep A"), ontology("b", "Other"), ontology("c", "Keep C")],
            })
        )
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryPlatformBackend({
                    baseUrl: "https://foundry.example",
                    egress: egress(fetch),
                });
                expect(fetch).not.toHaveBeenCalled();
                expect(yield* backend.query(query)).toEqual({
                    ontologies: [{ id: "a", apiName: "apia", displayName: "Keep A" }],
                });
                const request = new Request(fetch.mock.calls[0]![0]);
                expect(request.url).toBe("https://foundry.example/api/v2/ontologies");
                expect(request.method).toBe("GET");
                expect(fetch).toHaveBeenCalledTimes(1);

                const subset = objectSubset("Ontology", { where: eq(storageField("id"), "c") });
                const snapshot = yield* backend.loadSubset(subset);
                expect(snapshot.fulfilledSubset).toEqual(objectSubset("Ontology"));
                expect(snapshot.fetchedRows).toBe(3);
                const resolved = yield* resolveSubsetSnapshot(foundryPlatformOntology, subset, snapshot);
                expect(resolved.snapshot.rows).toEqual([
                    { key: "c", value: { id: "c", ...ontology("c", "Keep C") } },
                ]);
                expect(fetch).toHaveBeenCalledTimes(2);
            })
        )
    );
});

test.each([
    [401, "Unauthenticated"],
    [403, "Forbidden"],
    [503, "Unavailable"],
] as const)("platform SDK failures preserve typed HTTP %i classification", async (status, kind) => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryPlatformBackend({
                    baseUrl: "https://foundry.example",
                    egress: egress(() =>
                        Effect.succeed(Response.json({ message: "private provider detail" }, { status }))
                    ),
                });
                const result = yield* Effect.result(backend.loadSubset(objectSubset("Ontology")));
                expect(result).toMatchObject({ _tag: "Failure", failure: { kind } });
                if (result._tag === "Failure")
                    expect(result.failure.message).not.toContain("private provider detail");
            })
        )
    );
});

test("platform rejects malformed inventory and unsupported operations without inventing rows", async () => {
    const fetch = vi.fn<ConnectionEgress["fetch"]>(() =>
        Effect.succeed(Response.json({ data: [{ ...ontology("a"), rid: undefined }] }))
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryPlatformBackend({
                    baseUrl: "https://foundry.example",
                    egress: egress(fetch),
                });
                expect(yield* Effect.result(backend.loadSubset(objectSubset("Ontology")))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidResponse", operation: "foundry.platform.decode" },
                });
                expect(yield* Effect.result(backend.loadSubset(objectSubset("ObjectType")))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidRequest" },
                });
                expect(
                    yield* Effect.result(backend.applyAction({ id: "action", name: "write", parameters: {} }))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotImplemented" },
                });
                expect(fetch).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test("interrupting an inventory read cancels its authenticated egress work", async () => {
    let active = 0;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const started = yield* Deferred.make<void>();
                const stopped = yield* Deferred.make<void>();
                const backend = yield* makeFoundryPlatformBackend({
                    baseUrl: "https://foundry.example",
                    egress: egress(() =>
                        Effect.acquireUseRelease(
                            Effect.sync(() => {
                                active++;
                            }),
                            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                            () =>
                                Effect.sync(() => {
                                    active--;
                                }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)))
                        )
                    ),
                });
                const request = yield* backend.loadSubset(objectSubset("Ontology")).pipe(Effect.forkScoped);
                yield* Deferred.await(started);
                expect(active).toBe(1);
                yield* Fiber.interrupt(request);
                yield* Deferred.await(stopped);
                expect(active).toBe(0);
            })
        )
    );
});
