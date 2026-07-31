import { MemoryBlobBytesStore, SingleProcessCoordination } from "@party-stack/runtime";
import { describe, expect, it, vi } from "vitest";
import { o } from "../ir/index.js";
import { createLiveOntology, type OntologyDefinition } from "./LiveOntology.js";
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
    it("derives runtime scope and owns the provider result", async () => {
        const context = { account: { id: "user-1" }, role: "editor" };
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
            getUserId: (liveContext) => liveContext.account.id,
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
                });
            },
        });

        expect(ontology.ir).toBe(ir);
        expect(ontology.outbox).toBeDefined();
        await expect(ontology.queryFunctions.currentUser!({})).resolves.toBe("user-1");
        expect(receivedContext).toBe(context);
        await ontology.cleanup();
        expect(backend).toHaveBeenCalledOnce();
        expect(closeCoordination).toHaveBeenCalledOnce();
        expect(cleanupRuntime).toHaveBeenCalledOnce();
        expect(cleanupOrder).toEqual(["backend", "runtime", "coordination"]);
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
});
