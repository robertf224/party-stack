import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { asProvider } from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createLiveOntology, waitForLiveOntologyReady } from "./LiveOntology.js";
import type { OntologyBackendAdapter } from "./OntologyBackendAdapter.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [{ name: "save", displayName: "Save", parameters: [], logic: [] }],
    queryFunctionTypes: [
        { name: "currentUser", displayName: "Current user", parameters: [], returnType: o.string({}) },
    ],
};
const native = (overrides: Partial<OntologyBackendService> = {}): OntologyBackendService => ({
    name: "test",
    sourceId: "test",
    supportsIdempotency: true,
    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
    invoke: (action) => Effect.succeed({ invocationId: action.id, outcome: "committed", affected: [] }),
    queryFunction: () => Effect.succeed("user-1"),
    ...overrides,
});
const adapter = (backend = native()): OntologyBackendAdapter => ({
    name: "test",
    open: () => Effect.succeed(backend),
});
const platform = (online = true) => {
    return {
        owner: "user",
        namespace: crypto.randomUUID(),
        blobBytes: new MemoryBlobBytesStore(),

        connectivity: { isConnected: online, subscribe: () => () => undefined },
    };
};

describe("native LiveOntology construction", () => {
    it("uses the native Replica even without persistent storage and owns its acquisition scope", async () => {
        const released = vi.fn();
        const runtime = platform();
        const context = { user: "user-42" };
        const live = await createLiveOntology({
            ir,
            context,
            id: "ontology-a",
            runtime: asProvider((owner, namespace) => {
                expect(owner).toBe("user-42");
                expect(namespace).toBe("ontology-a");
                return runtime;
            }),
            backend: (_ir, received) => {
                expect(received).toBe(context);
                return {
                    name: "test",
                    open: () => Effect.acquireRelease(Effect.succeed(native()), () => Effect.sync(released)),
                };
            },
        });
        await waitForLiveOntologyReady(live);
        expect(live.storage).toBeDefined();
        expect(await live.queryFunctions.currentUser!({})).toBe("user-1");
        expect((await live.actions.save!({}))?.receipt?.outcome).toBe("committed");
        await live.cleanup();
        await live.cleanup();
        expect(released).toHaveBeenCalledOnce();
        expect(live.outbox.collection.status).toBe("cleaned-up");
    });

    it("cleans up providers when persistence cannot be supplied", async () => {
        const cleanupBackend = vi.fn();
        const runtime = platform();
        const cleanupRuntime = vi.fn();
        await expect(
            createLiveOntology({
                ir,
                persistObjects: true,
                backend: () => ({ ...adapter(), cleanup: cleanupBackend }),
                runtime: asProvider(() => ({ ...runtime, cleanup: cleanupRuntime })),
            })
        ).rejects.toThrow("owned Tables storage");
        expect(cleanupBackend).toHaveBeenCalledOnce();
        expect(cleanupRuntime).toHaveBeenCalledOnce();
    });

    it("releases runtime and binding on failed native acquisition", async () => {
        const runtime = platform();
        const cleanup = vi.fn();
        const cleanupRuntime = vi.fn();
        await expect(
            createLiveOntology({
                ir,
                runtime: asProvider(() => ({ ...runtime, cleanup: cleanupRuntime })),
                backend: () => ({
                    name: "fail",
                    cleanup,
                    open: () =>
                        Effect.fail(
                            new BackendError({
                                operation: "open",
                                kind: "Rejected",
                                message: "No access",
                                retryable: false,
                            })
                        ),
                }),
            })
        ).rejects.toMatchObject({ message: "No access" });
        expect(cleanup).toHaveBeenCalledOnce();
        expect(cleanupRuntime).toHaveBeenCalledOnce();
    });

    it("queued writes survive cancelling an observation and can later be awaited by ID", async () => {
        const runtime = platform(false);
        const invoke = vi.fn(native().invoke);
        const live = await createLiveOntology({
            ir,
            backend: () => adapter(native({ invoke })),
            runtime: asProvider(() => runtime),
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
            expect((await Effect.runPromise(live.storage!.pending)).map((a) => a.invocation.id)).toEqual([
                "offline",
            ]);
            expect(invoke).not.toHaveBeenCalled();
            runtime.connectivity.isConnected = true;
            await Effect.runPromise(live.storage!.syncOnce);
            expect(((await queued.completed) as { receipt: { outcome: string } }).receipt.outcome).toBe(
                "committed"
            );
            expect(await live.outbox.wait("offline")).toMatchObject({ receipt: { outcome: "committed" } });
        } finally {
            await live.cleanup();
        }
    });

    it("validation never dispatches an action and missing validation remains uncertain", async () => {
        const invoke = vi.fn(native().invoke);
        const validate = vi.fn(async () => ({
            certain: true as const,
            value: { kind: "ok" as const, value: undefined },
        }));
        const live = await createLiveOntology({
            ir,
            backend: () => ({ ...adapter(native({ invoke })), validateAction: validate }),
        });
        try {
            expect(await live.actions.save!.validate({})).toEqual({
                certain: true,
                value: { kind: "ok", value: undefined },
            });
            expect(validate).toHaveBeenCalledOnce();
            expect(invoke).not.toHaveBeenCalled();
        } finally {
            await live.cleanup();
        }
        const other = await createLiveOntology({ ir, backend: () => adapter() });
        try {
            expect(await other.actions.save!.validate({})).toEqual({ certain: false });
        } finally {
            await other.cleanup();
        }
    });

    it("outbox mode returns on local admission while direct mode waits for confirmation", async () => {
        const runtime = platform(false);
        const live = await createLiveOntology({
            ir,
            runtime: asProvider(() => runtime),
            backend: () => adapter(),
        });
        try {
            await expect(live.actions.save!({}, { mode: "direct" })).rejects.toThrow("connectivity");
            await expect(
                live.actions.save!({}, { mode: "outbox", idempotencyKey: "queued" })
            ).resolves.toBeUndefined();
            expect((await Effect.runPromise(live.storage!.pending))[0]?.invocation.id).toBe("queued");
        } finally {
            await live.cleanup();
        }
    });
});
