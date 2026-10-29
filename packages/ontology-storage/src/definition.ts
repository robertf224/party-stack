import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { Schema } from "effect";
import { encodeValue } from "./storage/values.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const decodeDefinition = Schema.decodeUnknownSync(OntologyIRSchema, { onExcessProperty: "error" });

/** Stable across property ordering introduced by schema/wire decoding.
 * The portable codec also preserves literal undefined, Temporal and collection values.
 */
export function ontologyDefinitionSignature(ir: OntologyIR): string {
    return encodeValue(decodeDefinition(ir));
}
