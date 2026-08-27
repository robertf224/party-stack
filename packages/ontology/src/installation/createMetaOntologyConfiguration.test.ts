import { describe, expect, it } from "vitest";
import { createMetaOntologyConfiguration } from "./createMetaOntologyConfiguration.js";
import type { OntologyIR } from "../ir/index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("createMetaOntologyConfiguration", () => {
    it("creates a non-persistent local metadata backend from IR", async () => {
        const configuration = createMetaOntologyConfiguration({
            ir,
        });
        const backend = await configuration.backend(configuration.ir, {});

        expect(configuration.persistObjects).toBe(false);
        expect(backend.name).toBe("local-metadata");
    });
});
