import { convertFoundryValueTypeFieldType } from "./convertMetaTypeDef.js";
import type { OntologyValueType } from "@osdk/foundry.ontologies";
import type { MetaValueType } from "@party-stack/ontology";

export function convertFoundryMetaValueType(valueType: OntologyValueType): MetaValueType {
    return {
        name: valueType.apiName,
        description: valueType.description,
        deprecated: valueType.status === "DEPRECATED" ? { message: "Deprecated in Foundry." } : undefined,
        type: convertFoundryValueTypeFieldType(valueType.fieldType, valueType.constraints),
    };
}
