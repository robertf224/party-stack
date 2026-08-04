import type { LinkTypeDef, OntologyIR } from "../../ir/index.js";

export class OntologyLinkError extends Error {
    constructor(message: string, opts?: { cause?: unknown }) {
        super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = "OntologyLinkError";
    }
}

export type ResolvedOntologyLink = {
    link: LinkTypeDef;
    /** Object type at the far end of this traversal. */
    targetObjectType: string;
    /** Side API name used when talking to a backend from the current object. */
    sideName: string;
    /** Inverse side API name. */
    inverseSideName: string;
    foreignKey?: string;
    /** True when the foreign key property lives on the current (source) object. */
    foreignKeyOnCurrentObject: boolean;
    cardinality: "one" | "many";
};

function objectTypeOwnsForeignKey(
    ir: OntologyIR,
    link: LinkTypeDef,
    objectType: string
): boolean {
    if (!link.foreignKey) {
        return false;
    }
    const objectTypeDefinition = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!objectTypeDefinition?.properties.some((property) => property.name === link.foreignKey)) {
        return false;
    }
    // Join keys commonly share a name with the referenced type's primary key.
    // The FK owner is the endpoint where that property is not the primary key.
    return (
        link.source.objectType === link.target.objectType ||
        objectTypeDefinition.primaryKey !== link.foreignKey
    );
}

/**
 * Finds a link by stable id, or by the outbound side API name from `sourceObjectType`.
 *
 * A side describes the role of objects on that side. From the source object, callers use
 * `target.name`; from the target object, callers use `source.name`.
 */
export function findLinkType(
    ir: OntologyIR,
    sourceObjectType: string,
    linkRef: { sideName: string } | { id: string }
): LinkTypeDef | undefined {
    if ("id" in linkRef) {
        return ir.linkTypes.find((candidate) => candidate.id === linkRef.id);
    }
    return ir.linkTypes.find(
        (candidate) =>
            (candidate.source.objectType === sourceObjectType &&
                candidate.target.name === linkRef.sideName) ||
            (candidate.target.objectType === sourceObjectType &&
                candidate.source.name === linkRef.sideName)
    );
}

export function resolveOntologyLink(
    ir: OntologyIR,
    sourceObjectType: string,
    linkRef: { sideName: string } | { id: string }
): ResolvedOntologyLink {
    const link = findLinkType(ir, sourceObjectType, linkRef);
    if (!link) {
        const label = "id" in linkRef ? `id=${linkRef.id}` : linkRef.sideName;
        throw new OntologyLinkError(`Link "${sourceObjectType}.${label}" was not found in the ontology IR.`);
    }

    const fromSourceEndpoint =
        "id" in linkRef
            ? link.source.objectType === sourceObjectType
            : link.source.objectType === sourceObjectType && link.target.name === linkRef.sideName;

    if (
        "id" in linkRef &&
        link.source.objectType !== sourceObjectType &&
        link.target.objectType !== sourceObjectType
    ) {
        throw new OntologyLinkError(
            `Link id "${linkRef.id}" does not connect object type "${sourceObjectType}".`
        );
    }

    if (fromSourceEndpoint) {
        return {
            link,
            targetObjectType: link.target.objectType,
            sideName: link.target.name,
            inverseSideName: link.source.name,
            foreignKey: link.foreignKey,
            foreignKeyOnCurrentObject:
                link.source.objectType === link.target.objectType ||
                objectTypeOwnsForeignKey(ir, link, link.source.objectType),
            cardinality:
                link.target.cardinality ??
                (link.foreignKey
                    ? "one"
                    : link.cardinality === "one"
                      ? "many"
                      : "one"),
        };
    }

    return {
        link,
        targetObjectType: link.source.objectType,
        sideName: link.source.name,
        inverseSideName: link.target.name,
        foreignKey: link.foreignKey,
        foreignKeyOnCurrentObject:
            link.source.objectType !== link.target.objectType &&
            objectTypeOwnsForeignKey(ir, link, link.target.objectType),
        cardinality: link.source.cardinality ?? link.cardinality,
    };
}

export function normalizeLinkRef(
    link: string | { sideName: string } | { id: string }
): { sideName: string } | { id: string } {
    if (typeof link === "string") {
        return { sideName: link };
    }
    return link;
}
