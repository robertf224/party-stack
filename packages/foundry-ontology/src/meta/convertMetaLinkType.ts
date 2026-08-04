import type { MetaLinkType } from "@party-stack/ontology";
import type { LinkTypeSideCardinality, LinkTypeSideV2, ObjectTypeFullMetadata } from "@osdk/foundry.ontologies";

interface OwnedLinkTypeSide {
    ownerObjectType: string;
    side: LinkTypeSideV2;
}

export function convertFoundryMetaLinkTypes(objectTypes: ObjectTypeFullMetadata[]): MetaLinkType[] {
    const sidesByRid = new Map<string, OwnedLinkTypeSide[]>();

    for (const objectType of objectTypes) {
        for (const linkType of objectType.linkTypes) {
            const key = linkType.linkTypeRid;
            const sides = sidesByRid.get(key) ?? [];
            sides.push({
                ownerObjectType: objectType.objectType.apiName,
                side: linkType,
            });
            sidesByRid.set(key, sides);
        }
    }

    return Array.from(sidesByRid.entries())
        .map(([id, sides]) => convertFoundryMetaLinkType(id, sides))
        .filter((linkType): linkType is MetaLinkType => linkType !== null);
}

function convertFoundryMetaLinkType(id: string, sides: OwnedLinkTypeSide[]): MetaLinkType | null {
    if (sides.length !== 2) {
        return null;
    }

    const sourceEntry = sides.find(({ side }) => side.foreignKeyPropertyApiName) ?? sides[0];
    const targetEntry = sides.find((entry) => entry !== sourceEntry);
    if (!sourceEntry || !targetEntry) {
        return null;
    }

    // Full metadata stores each outgoing link under its owner object type, while
    // `side.objectTypeApiName` and the side name/cardinality describe the linked side.
    // Canonical IR stores each role on the object type it represents, so the role
    // metadata is intentionally taken from the opposite owner's outgoing entry.
    const sourceRole = targetEntry.side;
    const targetRole = sourceEntry.side;
    const sourceCardinality = convertFoundryLinkCardinality(sourceRole.cardinality);
    const targetCardinality = convertFoundryLinkCardinality(targetRole.cardinality);

    return {
        id,
        source: {
            objectType: sourceEntry.ownerObjectType,
            name: sourceRole.apiName,
            displayName: sourceRole.displayName,
            cardinality: sourceCardinality,
        },
        target: {
            objectType: targetEntry.ownerObjectType,
            name: targetRole.apiName,
            displayName: targetRole.displayName,
            cardinality: targetCardinality,
        },
        foreignKey: sourceEntry.side.foreignKeyPropertyApiName,
        cardinality: sourceCardinality,
    };
}

function convertFoundryLinkCardinality(cardinality: LinkTypeSideCardinality): MetaLinkType["cardinality"] {
    return cardinality === "ONE" ? "one" : "many";
}
