import * as Spec from "@party-stack/ontology-spec";
import * as SpecJson from "@party-stack/ontology-spec/json";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as LegacyJson from "./json/index.js";
import * as Legacy from "./index.js";
import type { OntologyDefinition as LiveDefinition } from "./live/LiveOntology.js";

describe("ontology spec compatibility", () => {
    it("keeps existing public imports backed by the same definitions and functions", () => {
        expect(Legacy.o).toBe(Spec.o);
        expect(Legacy.defineOntology).toBe(Spec.defineOntology);
        expect(Legacy.applyLensToObject).toBe(Spec.applyLensToObject);
        expect(LegacyJson.encode).toBe(SpecJson.encode);
        expect(LegacyJson.decode).toBe(SpecJson.decode);
        expectTypeOf<LiveDefinition>().toEqualTypeOf<Spec.OntologyDefinition>();
    });
});
