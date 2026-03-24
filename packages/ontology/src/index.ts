export * from "./ir/index.js";
export * from "./live/index.js";
export * from "./OntologyConfig.js";
export * from "./meta/pull.js";
export type {
    MetaOntology,
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    ValueType as MetaValueType,
    ActionType as MetaActionType,
} from "./ontology/generated/types.js";
export { createMetaLiveOntology } from "./ontology/generated/live.js";
