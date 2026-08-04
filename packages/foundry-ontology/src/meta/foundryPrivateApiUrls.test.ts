import { describe, expect, it } from "vitest";
import { getOntologyMetadataBulkLoadEntitiesUrl } from "./foundryPrivateApiUrls.js";

describe("foundryPrivateApiUrls", () => {
    it("builds the OMS bulkLoadEntities URL from an install origin", () => {
        expect(getOntologyMetadataBulkLoadEntitiesUrl("https://foundry.example.com/workspace").href).toBe(
            "https://foundry.example.com/ontology-metadata/api/ontology/ontology/bulkLoadEntities"
        );
    });
});
