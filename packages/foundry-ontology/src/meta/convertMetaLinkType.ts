import { invariant } from "@bobbyfidz/panic";
import type {
    LinkTypeSideCardinality,
    LinkTypeSideV2,
    ObjectTypeFullMetadata,
} from "@osdk/foundry.ontologies";
import type { MetaLinkType } from "@party-stack/ontology";

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

    // Foundry sides describe outgoing traversal: objectTypeApiName and cardinality
    // describe the destination, while the FK lives on the enclosing object type.
    const forward = sides.find((side) => side.foreignKeyPropertyApiName);
    if (!forward) {
        return null;
    }

    const reverse = sides.find((side) => side !== forward);
    if (!reverse) {
        return null;
    }

    return {
        id,
        source: {
            objectType: reverse.objectTypeApiName,
            name: reverse.apiName,
            displayName: reverse.displayName,
        },
        target: {
            objectType: forward.objectTypeApiName,
            name: forward.apiName,
            displayName: forward.displayName,
        },
        foreignKey: (() => {
            invariant(forward.foreignKeyPropertyApiName, "Expected Foundry link foreign key.");
            return forward.foreignKeyPropertyApiName;
        })(),
        cardinality: convertFoundryLinkCardinality(reverse.cardinality),
    };
}

function convertFoundryLinkCardinality(cardinality: LinkTypeSideCardinality): MetaLinkType["cardinality"] {
    return cardinality === "ONE" ? "one" : "many";
}
