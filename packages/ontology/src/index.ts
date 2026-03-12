export * from "./ir/index.js";
export * from "./OntologyAdapter.js";
export * from "./OntologyConfig.js";
export * from "./LiveOntology.js";
export * from "./meta/pull.js";
export type {
    MetaOntology,
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    ValueType as MetaValueType,
} from "./ontology/generated/types.js";
export { createMetaLiveOntology } from "./ontology/generated/live.js";
