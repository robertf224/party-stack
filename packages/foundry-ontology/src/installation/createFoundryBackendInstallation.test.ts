import { describe, expect, it, vi } from "vitest";
import type { OntologyIR } from "@party-stack/ontology";
import * as metaAdapter from "../meta/createFoundryMetaOntologyBackendAdapter.js";
import { createFoundryOntologyRoute } from "./createFoundryBackendInstallation.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("createFoundryOntologyRoute", () => {
    it.each([30_000, false, undefined] as const)(
        "forwards metadata refetch interval %s through route configuration",
        async (refetchInterval) => {
            const createAdapter = vi.spyOn(metaAdapter, "createFoundryMetaOntologyBackendAdapter");
            const route = createFoundryOntologyRoute({
                ontologyId: "ri.ontology.main",
                ...(refetchInterval === undefined ? {} : { refetchInterval }),
            })("https://foundry.example");

            try {
                const configuration = await route.configureMeta!({
                    connection: {
                        userId: "user-1",
                        state: { status: "active" },
                    },
                    egress: {
                        fetch: globalThis.fetch,
                        createWebSocket: () => Promise.reject(new Error("not used")),
                    },
                    ontologyId: "ri.ontology.main",
                } as never);
                const backend = await configuration.backend(configuration.ir, {});
                try {
                    expect(createAdapter).toHaveBeenCalledOnce();
                    const adapterOptions = createAdapter.mock.calls[0]?.[0];
                    expect(adapterOptions?.client.ontologyRid).toBe("ri.ontology.main");
                    expect(adapterOptions?.refetchInterval).toBe(refetchInterval);
                } finally {
                    await backend.cleanup?.();
                }
            } finally {
                createAdapter.mockRestore();
            }
        }
    );

    it("creates a metadata-only route when IR is omitted", () => {
        const route = createFoundryOntologyRoute({
            ontologyId: "ri.ontology.main",
        })("https://foundry.example");

        expect(route.configure === undefined).toBe(true);
        expect(route.configureMeta !== undefined).toBe(true);
    });

    it("defers IR metadata projection to the installation", () => {
        const route = createFoundryOntologyRoute({
            ontologyId: "ri.ontology.main",
            ir,
        })("https://foundry.example");

        expect(route.configure !== undefined).toBe(true);
        expect(route.configureMeta === undefined).toBe(true);
    });

    it("forwards live to configured ontology backends", async () => {
        const route = createFoundryOntologyRoute({
            ontologyId: "ri.ontology.main",
            ir,
            live: false,
        })("https://foundry.example");
        const configuration = await route.configure!({
            connection: {
                userId: "user-1",
                state: { status: "active" },
            },
            egress: {
                fetch: globalThis.fetch,
                createWebSocket: () => Promise.reject(new Error("not used")),
            },
            ontologyId: "ri.ontology.main",
        } as never);

        await expect(configuration.backend(ir, {})).resolves.toMatchObject({
            name: "foundry",
            live: false,
        });
    });
});
