export type { RemoteOntologyTransport } from "./protocol.js";
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
