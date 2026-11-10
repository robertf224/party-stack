import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { Schema } from "effect";
import { protocolValueCodec } from "./protocol.js";

/** Definition, authenticated binding and capabilities needed to reopen a protocol client. */
export const OntologyDescriptionCodec = Schema.Struct({
    version: Schema.Literal(1),
    replication: Schema.Literals(["committed", "speculative"]),
    definitionHash: Schema.optional(Schema.String),
    sourceId: Schema.NonEmptyString,
    ir: Schema.optional(protocolValueCodec(OntologyIRSchema)),
    context: Schema.optional(protocolValueCodec(Schema.Record(Schema.String, Schema.Unknown))),
    supportsIdempotency: Schema.Boolean,
    delivery: Schema.optional(Schema.Boolean),
    stateDelivery: Schema.optional(Schema.Boolean),
    changes: Schema.optional(Schema.Boolean),
    watchChanges: Schema.optional(Schema.Boolean),
    watchSubset: Schema.optional(Schema.Boolean),
    actionParameterResolution: Schema.optional(Schema.Boolean),
    queries: Schema.optional(Schema.Boolean),
    pins: Schema.optional(Schema.Boolean),
    attachments: Schema.optional(Schema.Struct({ stage: Schema.Boolean })),
    encrypted: Schema.optional(Schema.Boolean),
});
export type OntologyDescription = typeof OntologyDescriptionCodec.Type;
