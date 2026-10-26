import { OntologiesV2 } from "@osdk/foundry.ontologies";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import { convertFoundryMetaValueType } from "./convertMetaValueType.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { MetaLinkType, MetaObjectType, MetaValueType } from "@party-stack/ontology";

export async function loadFoundryMetaOntology(client: OntologyClient): Promise<{
    objectTypes: MetaObjectType[];
    valueTypes: MetaValueType[];
    linkTypes: MetaLinkType[];
}> {
    const ontology = await OntologiesV2.getFullMetadata(client, client.ontologyRid);
    const objectTypeMetadata = Object.values(ontology.objectTypes);

    const objectTypes = objectTypeMetadata.map((metadata) => convertFoundryMetaObjectType(metadata));
    const valueTypes = Object.values(ontology.valueTypes).map(convertFoundryMetaValueType);
    const linkTypes = convertFoundryMetaLinkTypes(objectTypeMetadata);

    return {
        objectTypes,
        valueTypes,
        linkTypes,
    };
}
