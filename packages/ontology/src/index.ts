export * from "@party-stack/ontology-spec";
export * from "./live/index.js";
export * from "./OntologyPullConfig.js";
export type { OntologyObject } from "@party-stack/ontology-spec";
export * from "./meta/pull.js";
export type {
    MetaOntology,
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    PropertyDef as MetaObjectProperty,
    ValueType as MetaValueType,
    ActionType as MetaActionType,
    QueryFunctionType as MetaQueryFunctionType,
} from "@party-stack/ontology-spec/meta";
export { createMetaLiveOntology } from "./meta/generated/live.js";
export * from "./runtime/index.js";
export { ontologyCollections } from "./tanstack/descriptors.js";
export type { OntologyCollectionDescriptors, OntologyLinkDefinitions } from "./tanstack/descriptors.js";

export { createOntologyClient } from "./client.js";
export type {
    OntologyServerClient,
    OntologyClient,
    OntologyClientOptions,
    OntologyDescription,
    OntologyClientDefinition,
    OntologyClientDefinitionStatus,
} from "@party-stack/ontology-server/rpc";

export type { BackendError } from "@party-stack/ontology-backend";
