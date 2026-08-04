export * from "./ir/index.js";
export * from "./infer.js";
export * from "./live/index.js";
export * from "./OntologyConfig.js";
export type { OntologyObject } from "./live/objects/OntologyObject.js";
export * from "./meta/pull.js";
export * from "./meta/createStaticMetaOntologyBackend.js";
export type {
    MetaOntology,
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    ValueType as MetaValueType,
    ActionType as MetaActionType,
    QueryFunctionType as MetaQueryFunctionType,
} from "./meta/generated/types.js";
export { createMetaLiveOntology } from "./meta/generated/live.js";
