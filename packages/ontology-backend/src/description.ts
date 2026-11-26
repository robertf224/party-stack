import { Schema } from "effect";
import { protocolValueCodec } from "./protocol.js";

/** The authenticated binding and capabilities needed to reopen a protocol client. The definition
 * itself is served as meta ontology rows on the `meta` resource; the hashes identify it. */
export const OntologyDescriptionCodec = Schema.Struct({
    /** The protocol version. 2 serves the definition on the `meta` resource instead of here;
     * a retained version 1 description is still read, with the definition it was accepted with. */
    version: Schema.Literals([1, 2]),
    replication: Schema.Literals(["committed", "speculative"]),
    /** Hash of the whole definition the endpoint serves. */
    definitionHash: Schema.optional(Schema.String),
    /** Hash of its contract (without presentation); requests and delivery frames carry it. */
    contractHash: Schema.optional(Schema.String),
    sourceId: Schema.NonEmptyString,
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
    /** The definition is also served as meta ontology rows on the `meta` resource. */
    meta: Schema.optional(Schema.Boolean),
    attachments: Schema.optional(Schema.Struct({ stage: Schema.Boolean })),
    encrypted: Schema.optional(Schema.Boolean),
});
export type OntologyDescription = typeof OntologyDescriptionCodec.Type;
/** The protocol version servers describe and clients require from a fresh description. */
export const ontologyProtocolVersion = 2 as const;
