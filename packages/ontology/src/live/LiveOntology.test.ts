import { MemoryBlobBytesStore, SingleProcessCoordination } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { o } from "../ir/index.js";
import { createLiveOntology, waitForLiveOntologyReady, type OntologyDefinition } from "./LiveOntology.js";
import type { OntologyBackendAdapter } from "./OntologyBackendAdapter.js";
import type { OntologyIR } from "../ir/index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [
        {
            name: "currentUser",
            displayName: "Current User",
            parameters: [],
            returnType: o.string({}),
        },
    ],
};

const actionIr: OntologyIR = {
    ...ir,
    actionTypes: [
        {
            name: "save",
            displayName: "Save",
            parameters: [],
            logic: [],
        },
    ],
    queryFunctionTypes: [],
};

describe("createLiveOntology", () => {
    it("uses immutable context.user as the runtime owner", async () => {
        const context = { user: "user-42" };
        const ontology = await createLiveOntology({
            ir: { ...ir, queryFunctionTypes: [] },
            context,
            backend: (_providerIr, providerContext) => {
                expect(providerContext).toBe(context);
                return {
                    name: "test",
                    getCollectionOptions: () => {
                        throw new Error("unexpected collection");
                    },
                    applyAction: () => Promise.reject(new Error("unexpected action")),
                    runQueryFunction: () => Promise.reject(new Error("unexpected query")),
                };
            },
            runtime: (owner) => {
                expect(owner).toBe("user-42");
                return {
                    owner,
                    namespace: "auth-test",
                    blobBytes: new MemoryBlobBytesStore(),
                    coordination: new SingleProcessCoordination({
                        scope: "auth-test",
                    }),
                };
            },
        });

        expect(ontology.context.user).toBe("user-42");
        await ontology.cleanup();
    });

    it("derives runtime scope and owns the provider result", async () => {
        const context = {
            user: "user-1",
            account: { id: "user-1" },
            role: "editor",
        };
        let receivedContext: Record<string, unknown> | undefined;
        const cleanupOrder: string[] = [];
        const coordination = new SingleProcessCoordination({
            scope: "party-stack:user-1:ontology-1",
        });
        const closeCoordination = vi.spyOn(coordination, "close").mockImplementation(() => {
            cleanupOrder.push("coordination");
            return Promise.resolve();
        });
        const cleanupRuntime = vi.fn(async () => {
            cleanupOrder.push("runtime");
            await coordination.close();
        });
        const destroyRuntime = vi.fn(() => {
            cleanupOrder.push("destroy");
        });
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => {
                throw new Error("unexpected collection");
            },
            applyAction: () => Promise.reject(new Error("unexpected action")),
            runQueryFunction: (_name, _parameters, live) => {
                receivedContext = live.context;
                return Promise.resolve(context.account.id);
            },
            cleanup: () => {
                cleanupOrder.push("backend");
            },
        };
        const backend = vi.fn((providerIr: OntologyIR, providerContext: typeof context) => {
            expect(providerIr).toBe(ir);
            expect(providerContext).toBe(context);
            return backendAdapter;
        });

        const ontology = await createLiveOntology<OntologyDefinition, typeof context>({
            id: "ontology-1",
            ir,
            backend,
            context,
            runtime: (owner, namespace) => {
                expect(owner).toBe("user-1");
                expect(namespace).toBe("ontology-1");
                return Promise.resolve({
                    owner: "user-1",
                    namespace: "ontology-1",
                    blobBytes: {
                        write: () => Promise.resolve(),
                        read: () => Promise.reject(new Error("unexpected blob read")),
                        delete: () => Promise.resolve(),
                    },
                    coordination,
                    cleanup: cleanupRuntime,
                    destroy: destroyRuntime,
                });
            },
        });

        expect(ontology.ir).toBe(ir);
        expect(ontology.outbox).toBeDefined();
        await expect(ontology.queryFunctions.currentUser!({})).resolves.toBe("user-1");
        expect(receivedContext).toBe(context);
        const firstDestroy =
            ontology.destroy();
        const secondDestroy =
            ontology.destroy();
        expect(firstDestroy).toBe(
            secondDestroy
        );
        await firstDestroy;
        expect(backend).toHaveBeenCalledOnce();
        expect(closeCoordination).toHaveBeenCalledOnce();
        expect(cleanupRuntime).toHaveBeenCalledOnce();
        expect(
            destroyRuntime
        ).toHaveBeenCalledOnce();
        expect(cleanupOrder).toEqual([
            "backend",
            "runtime",
            "coordination",
            "destroy",
        ]);
    });

    it("routes individual writes independently of the defaults", async () => {
        const applyAction = vi.fn(() => Promise.resolve());
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => {
                throw new Error("unexpected collection");
            },
            applyAction,
            runQueryFunction: () => Promise.reject(new Error("unexpected query")),
        };
        const listeners = new Set<(isConnected: boolean) => void>();
        let isConnected = false;
        const coordination = new SingleProcessCoordination({
            scope: "write-routing",
        });

        const ontology = await createLiveOntology({
            id: "write-routing",
            ir: actionIr,
            backend: () => backendAdapter,
            runtime: () => ({
                owner: "user",
                namespace: "write-routing",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
                connectivity: {
                    get isConnected() {
                        return isConnected;
                    },
                    subscribe(listener) {
                        listeners.add(listener);
                        return () => listeners.delete(listener);
                    },
                },
            }),
        });

        await ontology.actions.save!({});
        expect(applyAction).toHaveBeenCalledOnce();

        const queued = ontology.actions.save!(
            {},
            {
                mode: "outbox",
                visibility: "optimistic",
            }
        );
        await vi.waitFor(() => {
            expect(ontology.outbox.collection.size).toBe(1);
        });
        expect(applyAction).toHaveBeenCalledOnce();
        const [entry] = Array.from(ontology.outbox.collection.values());
        expect(entry?.visibility).toBe("optimistic");

        isConnected = true;
        for (const listener of listeners) {
            listener(true);
        }
        await queued;
        expect(applyAction).toHaveBeenCalledTimes(2);
        await ontology.cleanup();
        await coordination.close();
    });

    it("validates an action without applying it", async () => {
        const applyAction = vi.fn(() => Promise.resolve());
        const validateAction = vi.fn(() =>
            Promise.resolve({
                certain: true as const,
                value: {
                    kind: "err" as const,
                    value: [{ message: "Invalid action." }],
                },
            })
        );
        const validateActionDraft = vi.fn(() =>
            Promise.resolve({
                certain: false as const,
            })
        );
        const context = { user: "user-1" };
        const ontology = await createLiveOntology({
            id: "action-validation",
            ir: actionIr,
            context,
            backend: () => ({
                name: "test",
                getCollectionOptions: () => {
                    throw new Error("unexpected collection");
                },
                applyAction,
                validateAction,
                validateActionDraft,
                runQueryFunction: () => Promise.reject(new Error("unexpected query")),
            }),
            runtime: () => ({
                owner: "user-1",
                namespace: "action-validation",
                blobBytes: new MemoryBlobBytesStore(),
                coordination: new SingleProcessCoordination({
                    scope: "action-validation",
                }),
            }),
        });

        await expect(ontology.actions.save!.validate({})).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [{ message: "Invalid action." }],
            },
        });
        expect(validateAction).toHaveBeenCalledWith("save", {}, {
            objects: {},
            context,
        });
        await ontology.actions.save!.validateDraft({}, {
            knownParameters: [],
        });
        expect(validateActionDraft).toHaveBeenCalledWith("save", {}, {
            objects: {},
            context,
            knownParameters: [],
        });
        expect(applyAction).not.toHaveBeenCalled();
        await ontology.cleanup();
    });

    it("reports uncertain validation when the backend does not implement it", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "unsupported-action-validation",
        });
        const ontology = await createLiveOntology({
            id: "unsupported-action-validation",
            ir: actionIr,
            backend: () => ({
                name: "test",
                getCollectionOptions: () => {
                    throw new Error("unexpected collection");
                },
                applyAction: () => Promise.resolve(),
                runQueryFunction: () => Promise.reject(new Error("unexpected query")),
            }),
            runtime: () => ({
                owner: "user",
                namespace: "unsupported-action-validation",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
            }),
        });

        await expect(ontology.actions.save!.validate({})).resolves.toEqual({
            certain: false,
        });
        await ontology.cleanup();
        await coordination.close();
    });

    it("exposes ready and settles immediate cleanup without unhandled rejections", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);

        const coordination = new SingleProcessCoordination({
            scope: "lifecycle-cleanup",
        });
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => ({
                syncMode: "on-demand",
                sync: {
                    sync: ({ markReady }) => {
                        markReady();
                        return {};
                    },
                },
            }),
            applyAction: () => Promise.resolve(),
            runQueryFunction: () => Promise.resolve(undefined),
        };

        try {
            const ontology = await createLiveOntology({
                id: "lifecycle-cleanup",
                ir: {
                    ...ir,
                    objectTypes: [
                        {
                            name: "Note",
                            displayName: "Note",
                            pluralDisplayName: "Notes",
                            primaryKey: "id",
                            properties: [
                                {
                                    name: "id",
                                    displayName: "ID",
                                    type: o.string({}),
                                },
                            ],
                        },
                    ],
                    queryFunctionTypes: [],
                },
                backend: () => backendAdapter,
                runtime: () => ({
                    owner: "user",
                    namespace: "lifecycle-cleanup",
                    blobBytes: new MemoryBlobBytesStore(),
                    coordination,
                }),
            });

            const ready = ontology.ready;
            await expect(Promise.all([ready, ontology.cleanup()])).resolves.toBeDefined();
            await expect(ontology.cleanup()).resolves.toBeUndefined();
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
            await coordination.close();
        }
    });

    it("waits for on-demand collections via waitForLiveOntologyReady", async () => {
        let syncStarted = false;
        const coordination = new SingleProcessCoordination({
            scope: "wait-ready",
        });
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            getCollectionOptions: () => ({
                syncMode: "on-demand",
                sync: {
                    sync: ({ markReady }) => {
                        syncStarted = true;
                        // Defer ready so waitForCollectionReady must start sync first.
                        queueMicrotask(() => markReady());
                        return {
                            loadSubset: () => true as const,
                        };
                    },
                },
            }),
            applyAction: () => Promise.resolve(),
            runQueryFunction: () => Promise.resolve(undefined),
        };

        const ontology = await createLiveOntology({
            id: "wait-ready",
            ir: {
                ...ir,
                objectTypes: [
                    {
                        name: "Note",
                        displayName: "Note",
                        pluralDisplayName: "Notes",
                        primaryKey: "id",
                        properties: [
                            {
                                name: "id",
                                displayName: "ID",
                                type: o.string({}),
                            },
                        ],
                    },
                ],
                queryFunctionTypes: [],
            },
            backend: () => backendAdapter,
            runtime: () => ({
                owner: "user",
                namespace: "wait-ready",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
            }),
        });

        expect(ontology.objects.Note!.status).toBe("idle");
        await expect(waitForLiveOntologyReady(ontology)).resolves.toBeUndefined();
        expect(syncStarted).toBe(true);
        expect(ontology.objects.Note!.status).toBe("ready");
        await ontology.cleanup();
        await coordination.close();
    });
});
