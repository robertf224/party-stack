import { invariant } from "@bobbyfidz/panic";
import type { MetaLinkType } from "@party-stack/ontology";
import type { LinkTypeSideCardinality, LinkTypeSideV2, ObjectTypeFullMetadata } from "@osdk/foundry.ontologies";

export function convertFoundryMetaLinkTypes(objectTypes: ObjectTypeFullMetadata[]): MetaLinkType[] {
    const sidesByRid = new Map<string, LinkTypeSideV2[]>();

    for (const objectType of objectTypes) {
        for (const linkType of objectType.linkTypes) {
            const key = linkType.linkTypeRid;
            const sides = sidesByRid.get(key) ?? [];
            sides.push(linkType);
            sidesByRid.set(key, sides);
        }
    }

    return Array.from(sidesByRid.entries())
        .map(([id, sides]) => convertFoundryMetaLinkType(id, sides))
        .filter((linkType): linkType is MetaLinkType => linkType !== null);
}

function convertFoundryMetaLinkType(id: string, sides: LinkTypeSideV2[]): MetaLinkType | null {
    if (sides.length !== 2) {
        return null;
    }

    const source = sides.find((side) => side.foreignKeyPropertyApiName);
    if (!source) {
        return null;
    }

    const target = sides.find((side) => side !== source);
    if (!target) {
        return null;
    }

    return {
        id,
        source: {
            objectType: source.objectTypeApiName,
            name: source.apiName,
            displayName: source.displayName,
        },
        target: {
            objectType: target.objectTypeApiName,
            name: target.apiName,
            displayName: target.displayName,
        },
        foreignKey: (() => {
            invariant(source.foreignKeyPropertyApiName, "Expected Foundry link foreign key.");
            return source.foreignKeyPropertyApiName;
        })(),
        cardinality: convertFoundryLinkCardinality(source.cardinality),
    };
}

function convertFoundryLinkCardinality(cardinality: LinkTypeSideCardinality): MetaLinkType["cardinality"] {
    return cardinality === "ONE" ? "one" : "many";
}
