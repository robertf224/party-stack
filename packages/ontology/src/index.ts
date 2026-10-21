export * from "@party-stack/ontology-spec";
export * from "./live/index.js";
export * from "./installation/index.js";
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
