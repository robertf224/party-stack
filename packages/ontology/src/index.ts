export * from "./ir/index.js";
export * from "./infer.js";
export * from "./lenses.js";
export * from "./live/index.js";
export * from "./installation/index.js";
export * from "./OntologyPullConfig.js";
export { certain, uncertain, type Uncertain } from "./utils/uncertain.js";
export type { OntologyObject } from "./live/objects/OntologyObject.js";
export * from "./meta/pull.js";
export type {
    MetaOntology,
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    PropertyDef as MetaObjectProperty,
    ValueType as MetaValueType,
    ActionType as MetaActionType,
    QueryFunctionType as MetaQueryFunctionType,
} from "./meta/generated/types.js";
export { createMetaLiveOntology } from "./meta/generated/live.js";
