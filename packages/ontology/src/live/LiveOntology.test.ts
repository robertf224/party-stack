import {
    BackendError,
    makeOntologyBackend,
    type OntologyBackendService,
} from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { OntologyStorageError, ConfigurationError } from "@party-stack/ontology-storage";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { Runtime, MemoryBlobBytesStore } from "@party-stack/runtime";
import { asRuntimeLayer } from "@party-stack/runtime/testing";
import { queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it, vi } from "vite-plus/test";
import { createLiveOntology } from "./LiveOntology.js";
import type { attachment } from "@party-stack/ontology-spec/values";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [{ name: "save", displayName: "Save", parameters: [], logic: [] }],
    queryFunctionTypes: [
        { name: "currentUser", displayName: "Current user", parameters: [], returnType: o.string({}) },
    ],
};
const native = (overrides: Partial<OntologyBackendService> = {}): OntologyBackendService =>
    makeOntologyBackend({
        ir,
        name: "test",
        sourceId: "test",
        supportsIdempotency: true,
        loadSubset: () => Effect.succeed({ rows: [], complete: true }),
        applyAction: (action) =>
            Effect.succeed({ operationId: action.id, outcome: "committed", affected: [] }),
        queryFunction: () => Effect.succeed("user-1"),
        ...overrides,
    });
const adapter = (backend = native()) => Effect.succeed(backend);
const platform = (online = true) => {
    return {
        owner: "user",
        namespace: crypto.randomUUID(),
        blobBytes: new MemoryBlobBytesStore(),

        connectivity: { isConnected: online, subscribe: () => () => undefined },
    };
};

describe("native LiveOntology construction", () => {
    it("typed action calls accept File inputs and providers receive handles with staged uploads", async () => {
        type UploadDefinition = {
            objectTypes: {};
            queryFunctionTypes: {};
            actionTypes: {
                upload: {
                    parameters: { file: attachment };
                    inputParameters: { file: attachment | Blob };
                    returnType: void;
                };
            };
        };
        const uploadIR: OntologyIR = {
            ...ir,
            actionTypes: [
                {
                    name: "upload",
                    displayName: "Upload",
                    logic: [],
                    parameters: [{ name: "file", displayName: "File", type: o.attachment({}) }],
                },
            ],
        };
        const received: { parameters: unknown; text: string }[] = [];
        const backend = makeOntologyBackend({
            ir: uploadIR,
            name: "uploads",
            sourceId: "uploads",
            supportsIdempotency: true,
            loadSubset: () => Effect.succeed({ rows: [], complete: true }),
            queryFunction: () => Effect.void,
            applyAction: (action) =>
                Effect.gen(function* () {
                    const blob = yield* collectByteBlob(action.attachmentUploads![0]!.blob).pipe(
                        Effect.orDie
                    );
                    received.push({
                        parameters: action.parameters,
                        text: yield* Effect.promise(() => blob.text()),
                    });
                    return { operationId: action.id, outcome: "committed" as const, affected: [] };
                }),
        });
        const live = await createLiveOntology<UploadDefinition>({
            ir: uploadIR,
            backend: Effect.succeed(backend),
            runtime: asRuntimeLayer(() => platform()),
        });
        try {
            const file = new File(["hello"], "hello.txt", { type: "text/plain" });
            await live.actions.upload({ file });
            expect(received).toMatchObject([
                {
                    parameters: {
                        file: { id: expect.stringMatching(/^action-attachment:/), type: "text/plain" },
                    },
                    text: "hello",
                },
            ]);
            expect((received[0]!.parameters as { file: unknown }).file).not.toBeInstanceOf(Blob);
        } finally {
            await live.cleanup();
        }
    });
    it("cachedObjects is lazy, shares the replica and observes data without acquiring upstream demand", async () => {
        const loadSubset = vi.fn(() =>
            Effect.succeed({ complete: true, rows: [{ key: "one", value: { id: "one", title: "Loaded" } }] })
        );
        const live = await createLiveOntology({
            ir: {
                ...ir,
                objectTypes: [
                    {
                        name: "Note",
                        displayName: "Note",
                        pluralDisplayName: "Notes",
                        primaryKey: "id",
                        properties: ["id", "title"].map((name) => ({
                            name,
                            displayName: name,
                            type: o.string({}),
                        })),
                    },
                ],
            },
            backend: adapter(native({ loadSubset })),
            runtime: asRuntimeLayer(() => platform()),
        });
        const collections = vi.spyOn(live.dbClient, "collection");
        let cached;
        try {
            expect(Object.keys(live.objects)).toEqual(["Note"]);
            expect(Object.keys(live.cachedObjects)).toEqual(["Note"]);
            expect(collections).not.toHaveBeenCalled();
            expect(loadSubset).not.toHaveBeenCalled();
            cached = live.cachedObjects.Note!;
            expect(cached).toBe(live.cachedObjects.Note);
            expect(collections).toHaveBeenCalledTimes(1);
            expect(await queryOnce((q) => q.from({ note: cached! }))).toEqual([]);
            expect(loadSubset).not.toHaveBeenCalled();
            expect(await queryOnce((q) => q.from({ note: live.objects.Note! }))).toMatchObject([
                { id: "one" },
            ]);
            expect(loadSubset).toHaveBeenCalledTimes(1);
            expect(collections).toHaveBeenCalledTimes(2);
            expect(await queryOnce((q) => q.from({ note: cached! }))).toMatchObject([{ title: "Loaded" }]);
            expect(loadSubset).toHaveBeenCalledTimes(1);
        } finally {
            await live.cleanup();
        }
        expect(cached?.status).toBe("cleaned-up");
    });
    it("outbox edits preserve replay and Temporal values and report missing entries with a typed error", async () => {
        const live = await createLiveOntology({
            ir: {
                ...ir,
                actionTypes: [
                    {
                        ...ir.actionTypes[0]!,
                        parameters: [{ name: "at", displayName: "At", type: o.timestamp({}) }],
                    },
                ],
            },
            runtime: asRuntimeLayer(() => platform(false)),
            backend: adapter(),
        });
        const replay = { now: "2026-11-03T12:00:00Z", seed: "edit-test" };
        try {
            await live.outbox.enqueue({
                idempotencyKey: "edit",
                actionTypeName: "save",
                parameters: { at: Temporal.Instant.from(replay.now) },
                replay,
            });
            await live.outbox.edit("edit", (request) => {
                request.parameters.extra = "changed";
            });
            const status = await Effect.runPromise(live.replica.outbox.get("edit"));
            expect(status.pending?.invocation.replay).toEqual(replay);
            expect(status.pending?.invocation.parameters.at).toBeInstanceOf(Temporal.Instant);
            await expect(live.outbox.edit("missing", () => {})).rejects.toMatchObject({
                kind: "NotFound",
                operation: "outbox.edit",
            });
        } finally {
            await live.cleanup();
        }
    });
    it("delegates query functions through Replica and preserves logical Temporal results", async () => {
        const queryFunction = vi.fn(() => Effect.succeed(Temporal.Instant.from("2026-11-03T12:00:00Z")));
        const live = await createLiveOntology({
            ir: {
                ...ir,
                queryFunctionTypes: [{ ...ir.queryFunctionTypes[0]!, returnType: o.timestamp({}) }],
            },
            runtime: asRuntimeLayer(() => platform()),
            backend: adapter(native({ queryFunction })),
        });
        try {
            expect(live.replica.queryFunction).toBeTypeOf("function");
            const result = await live.queryFunctions.currentUser!({});
            expect(result).toBeInstanceOf(Temporal.Instant);
            expect(String(result)).toBe("2026-11-03T12:00:00Z");
            expect(queryFunction).toHaveBeenCalledWith("currentUser", {});
        } finally {
            await live.cleanup();
        }
    });
    it("decodes authoritative action results after confirmation", async () => {
        const live = await createLiveOntology({
            ir: { ...ir, actionTypes: [{ ...ir.actionTypes[0]!, returnType: o.timestamp({}) }] },
            runtime: asRuntimeLayer(() => platform()),
            backend: adapter(
                native({
                    applyAction: (request) =>
                        Effect.succeed({
                            operationId: request.id,
                            outcome: "committed",
                            affected: [],
                            result: "2026-11-03T12:00:00Z",
                        }),
                })
            ),
        });
        try {
            const result = await live.actions.save!({});
            expect(result.result).toBeInstanceOf(Temporal.Instant);
            expect(String(result.result)).toBe("2026-11-03T12:00:00Z");
            expect(result.receipt?.result).toBe("2026-11-03T12:00:00Z");
        } finally {
            await live.cleanup();
        }
    });
    it("keeps action.resolveParameters on the native backend path without submitting", async () => {
        const resolve = vi.fn((name: string, parameters: Record<string, unknown>) =>
            Effect.succeed({ ...parameters, title: `prefill-${name}` })
        );
        const applyAction = vi.fn(() => Effect.die("must not submit"));
        const live = await createLiveOntology({
            ir,
            runtime: asRuntimeLayer(() => platform()),
            backend: adapter(native({ resolveActionParameters: resolve, applyAction })),
        });
        try {
            expect(await live.actions.save!.resolveParameters({ id: "existing" })).toEqual({
                id: "existing",
                title: "prefill-save",
            });
            expect(resolve).toHaveBeenCalledWith("save", { id: "existing" });
            expect(applyAction).not.toHaveBeenCalled();
            expect(live.outbox.collection.size).toBe(0);
        } finally {
            await live.cleanup();
        }
    });
    it("uses the native Replica even without persistent storage and owns its acquisition scope", async () => {
        const released = vi.fn();
        const runtime = platform();
        const context = { user: "user-42" };
        const live = await createLiveOntology({
            ir,
            context,
            id: "ontology-a",
            runtime: asRuntimeLayer((owner, namespace) => {
                expect(owner).toBe("user-42");
                expect(namespace).toBe("ontology-a");
                return runtime;
            }),
            backend: Effect.gen(function* () {
                expect((yield* Runtime).owner).toBe("user-42");
                yield* Effect.addFinalizer(() => Effect.sync(released));
                return native();
            }),
        });
        expect(live.replica).toBeDefined();
        expect(await live.queryFunctions.currentUser!({})).toBe("user-1");
        expect((await live.actions.save!({}))?.receipt?.outcome).toBe("committed");
        await live.cleanup();
        await live.cleanup();
        expect(released).toHaveBeenCalledOnce();
        expect(live.outbox.collection.status).toBe("cleaned-up");
    });

    it("releases platform resources when Tables acquisition fails", async () => {
        const openBackend = vi.fn(() => native());
        const runtime = platform();
        const cleanupRuntime = vi.fn();
        await expect(
            createLiveOntology({
                ir,
                backend: Effect.sync(openBackend),
                runtime: asRuntimeLayer(() => ({
                    ...runtime,
                    tables: Effect.fail(
                        new OntologyStorageError({
                            operation: "open",
                            reason: new ConfigurationError({ message: "Could not open tables." }),
                        })
                    ),
                    cleanup: cleanupRuntime,
                })),
            })
        ).rejects.toMatchObject({ _tag: "OntologyStorageError" });
        expect(openBackend).not.toHaveBeenCalled();
        expect(cleanupRuntime).toHaveBeenCalledOnce();
    });

    it("releases runtime and binding on failed native acquisition", async () => {
        const runtime = platform();
        const cleanup = vi.fn();
        const cleanupRuntime = vi.fn();
        await expect(
            createLiveOntology({
                ir,
                runtime: asRuntimeLayer(() => ({ ...runtime, cleanup: cleanupRuntime })),
                backend: Effect.acquireRelease(Effect.void, () => Effect.sync(cleanup)).pipe(
                    Effect.andThen(
                        Effect.fail(
                            new BackendError({
                                operation: "open",
                                kind: "ValidationFailed",
                                message: "No access",
                                retryable: false,
                            })
                        )
                    )
                ),
            })
        ).rejects.toMatchObject({ message: "No access" });
        expect(cleanup).toHaveBeenCalledOnce();
        expect(cleanupRuntime).toHaveBeenCalledOnce();
    });

    it("queued writes survive cancelling an observation and can later be awaited by ID", async () => {
        const runtime = platform(false);
        const applyAction = vi.fn(native().applyAction);
        const live = await createLiveOntology({
            ir,
            backend: adapter(native({ applyAction })),
            runtime: asRuntimeLayer(() => runtime),
        });
        try {
            const queued = await live.outbox.enqueue({
                actionTypeName: "save",
                parameters: {},
                idempotencyKey: "offline",
            });
            const abort = new AbortController();
            const waiting = live.outbox.wait("offline", { signal: abort.signal });
            abort.abort();
            await expect(waiting).rejects.toBeDefined();
            expect(
                (await Effect.runPromise(live.replica!.outbox.entries)).map((a) => a.invocation.id)
            ).toEqual(["offline"]);
            expect(applyAction).not.toHaveBeenCalled();
            runtime.connectivity.isConnected = true;
            await Effect.runPromise(live.replica!.syncOnce);
            expect(((await queued.completed) as { receipt: { outcome: string } }).receipt.outcome).toBe(
                "committed"
            );
            expect(await live.outbox.wait("offline")).toMatchObject({ receipt: { outcome: "committed" } });
        } finally {
            await live.cleanup();
        }
    });

    it("validation never dispatches an action and missing validation remains uncertain", async () => {
        const applyAction = vi.fn(native().applyAction);
        const validate = vi.fn(() =>
            Effect.succeed({
                certain: true as const,
                value: { kind: "ok" as const, value: undefined },
            })
        );
        const live = await createLiveOntology({
            ir,
            backend: adapter(native({ applyAction, validateAction: validate })),
        });
        try {
            expect(await live.actions.save!.validate({})).toEqual({
                certain: true,
                value: { kind: "ok", value: undefined },
            });
            expect(validate).toHaveBeenCalledOnce();
            expect(applyAction).not.toHaveBeenCalled();
        } finally {
            await live.cleanup();
        }
        const other = await createLiveOntology({ ir, backend: adapter() });
        try {
            expect(await other.actions.save!.validate({})).toEqual({ certain: false });
        } finally {
            await other.cleanup();
        }
    });

    it.each(["confirmed", "optimistic"] as const)(
        "actions queue offline and await confirmation (visibility: %s)",
        async (visibility) => {
            const runtime = platform(false);
            const applyAction = vi.fn(native().applyAction);
            const live = await createLiveOntology({
                ir,
                runtime: asRuntimeLayer(() => runtime),
                backend: adapter(native({ applyAction })),
            });
            try {
                expect(await Effect.runPromise(live.replica!.outbox.entries)).toEqual([]);
                const confirmed = vi.fn();
                const applying = live.actions.save!({}, { visibility, idempotencyKey: "queued" }).then(
                    (result) => {
                        confirmed();
                        return result;
                    }
                );
                await vi.waitFor(async () => {
                    expect(await Effect.runPromise(live.replica!.outbox.entries)).toHaveLength(1);
                });
                expect((await Effect.runPromise(live.replica!.outbox.entries))[0]).toMatchObject({
                    invocation: { id: "queued" },
                    optimistic: visibility === "optimistic",
                });
                expect(confirmed).not.toHaveBeenCalled();
                expect(applyAction).not.toHaveBeenCalled();
                runtime.connectivity.isConnected = true;
                await Effect.runPromise(live.replica!.syncOnce);
                await expect(applying).resolves.toMatchObject({ receipt: { outcome: "committed" } });
                expect(confirmed).toHaveBeenCalledOnce();
            } finally {
                await live.cleanup();
            }
        }
    );

    it("high-level outbox actions reject with the final structured error after discard-all", async () => {
        const failure = new BackendError({
            operation: "applyAction",
            kind: "ValidationFailed",
            message: "Submission failed validation.",
            retryable: false,
            actionOutcome: "not-committed",
            issues: [{ path: ["project"], code: "InvalidObjectReference", message: "Choose a valid value." }],
        });
        const applyAction = vi.fn(() => Effect.fail(failure));
        const live = await createLiveOntology({
            ir,
            runtime: asRuntimeLayer(() => platform()),
            backend: adapter(native({ applyAction })),
            writes: { outbox: { failureStrategy: "discard-all" } },
        });
        try {
            await expect(live.actions.save!({})).rejects.toMatchObject({
                kind: "ValidationFailed",
                actionOutcome: "not-committed",
                issues: failure.issues,
            });
            expect(await Effect.runPromise(live.replica!.outbox.entries)).toEqual([]);
            expect(applyAction).toHaveBeenCalledOnce();
        } finally {
            await live.cleanup();
        }
    });
});
