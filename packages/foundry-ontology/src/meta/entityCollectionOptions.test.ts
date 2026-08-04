import { createMetaLiveOntology } from "@party-stack/ontology";
import { eq, queryOnce } from "@tanstack/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import { createFoundryMetaOntologyBackendAdapter } from "./createFoundryMetaOntologyBackendAdapter.js";
import type { ObjectTypeV2 } from "@osdk/foundry.ontologies";

const mocks = vi.hoisted(() => ({
    getFullMetadata: vi.fn(),
}));

vi.mock("@osdk/foundry.ontologies", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.ontologies")>();
    return {
        ...original,
        OntologiesV2: {
            ...original.OntologiesV2,
            getFullMetadata: mocks.getFullMetadata,
        },
    };
});

function objectType(): ObjectTypeV2 {
    return {
        apiName: "Employee",
        displayName: "Employee",
        pluralDisplayName: "Employees",
        status: "ACTIVE",
        primaryKey: "id",
        titleProperty: "fullName",
        properties: {
            id: {
                dataType: { type: "string" },
                rid: "ri.ontology.main.property.employee-id",
                status: { type: "active" },
                typeClasses: [],
            },
            fullName: {
                dataType: { type: "string" },
                rid: "ri.ontology.main.property.employee-name",
                status: { type: "active" },
                typeClasses: [],
            },
        },
        rid: "ri.ontology.main.object-type.employee",
    } as unknown as ObjectTypeV2;
}

const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ri.ontology.main.ontology.example",
    tokenProvider: () => Promise.resolve("token"),
    fetch: globalThis.fetch,
};

beforeEach(() => {
    mocks.getFullMetadata.mockReset();
});

describe("Foundry ObjectType metadata queries", () => {
    it("filters the shared full-metadata snapshot by ID", async () => {
        mocks.getFullMetadata.mockResolvedValue({
            objectTypes: {
                Employee: {
                    objectType: objectType(),
                    linkTypes: [],
                    implementsInterfaces: [],
                    implementsInterfaces2: {},
                    sharedPropertyTypeMapping: {},
                },
            },
            valueTypes: {},
        });
        const meta = await createMetaLiveOntology({
            backend: () => createFoundryMetaOntologyBackendAdapter({ client }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q
                    .from({ ObjectType: meta.objects.ObjectType })
                    .where(({ ObjectType }) =>
                        eq(
                            ObjectType.id,
                            "ri.ontology.main.object-type.employee"
                        )
                    )
            );

            expect(mocks.getFullMetadata).toHaveBeenCalledOnce();
            expect(rows).toEqual([
                expect.objectContaining({
                    id: "ri.ontology.main.object-type.employee",
                    name: "Employee",
                    title: "fullName",
                    properties: [
                        expect.objectContaining({
                            id: "ri.ontology.main.property.employee-id",
                            name: "id",
                        }),
                        expect.objectContaining({
                            id: "ri.ontology.main.property.employee-name",
                            name: "fullName",
                        }),
                    ],
                }),
            ]);
        } finally {
            await meta.cleanup();
        }
    });
});
