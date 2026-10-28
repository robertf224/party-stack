export type { RemoteOntologyTransport, ResolvableRemoteOntologyTransport } from "./protocol.js";
export {
    RemoteOntologyError,
    parseRemoteOntologyErrorBody,
    remoteOntologyErrorFromUnknown,
    isRemoteOntologyErrorEnvelope,
    remoteOntologyErrorEnvelopeSchema,
} from "./errors.js";
export type {
    RemoteOntologyErrorCode,
    RemoteOntologyErrorDetails,
    RemoteOntologyErrorEnvelope,
} from "./errors.js";
export * from "./backend.js";

export { makeOntologyServer } from "./composition.js";
export type { OntologyServerOptions } from "./composition.js";
