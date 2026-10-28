import { Schema } from "effect";
import definition from "../ir/schema.js";
import { compileEffectSchemas } from "./compiler.js";
import type { OntologyIR, QueryDocument } from "../ir/generated/types.js";

// These boundary schemas are derived from the same self-describing definitions
// that generate the portable TypeScript interfaces.
const schemas = compileEffectSchemas(definition).namedSchemas;
export const OntologyIRSchema = Schema.toEncoded(schemas.OntologyIR!) as Schema.Codec<OntologyIR>;
export const QueryDocumentSchema = Schema.toEncoded(schemas.QueryDocument!) as Schema.Codec<QueryDocument>;
