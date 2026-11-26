import type {
    ActionTypeDef,
    LinkTypeDef,
    NamedTypeDef,
    ObjectTypeDef,
    OntologyIR,
    PropertyDef,
    QueryFunctionTypeDef,
} from "./generated/types.js";

/**
 * Definition ids. A provider (for example a platform's metadata) may give its definitions stable
 * ids that survive renames. A definition without one has a default: its name, or for a link type
 * its source object type and the name it is traversed by from there (`target.name`). Meta
 * ontology rows always carry an id.
 */
export const objectTypeId = (type: Pick<ObjectTypeDef, "id" | "name">) => type.id ?? type.name;
export const propertyId = (property: Pick<PropertyDef, "id" | "name">) => property.id ?? property.name;
export const actionTypeId = (type: Pick<ActionTypeDef, "id" | "name">) => type.id ?? type.name;
export const queryFunctionTypeId = (type: Pick<QueryFunctionTypeDef, "id" | "name">) => type.id ?? type.name;
export const valueTypeId = (type: Pick<NamedTypeDef, "id" | "name">) => type.id ?? type.name;
export const linkTypeId = (link: Pick<LinkTypeDef, "id" | "source" | "target">) =>
    link.id ?? `${link.source.objectType}.${link.target.name}`;

const withId = <A extends { readonly id?: string }>(node: A, id: string): A & { readonly id: string } => ({
    ...node,
    id,
});
const withoutDefault = <A extends { readonly id?: string }>(node: A, id: string): A => {
    if (node.id !== id) return node;
    const { id: _, ...rest } = node;
    return rest as A;
};
const mapIds = (
    ir: OntologyIR,
    set: <A extends { readonly id?: string }>(node: A, id: string) => A
): OntologyIR => ({
    ...ir,
    types: ir.types.map((type) => set(type, valueTypeId({ ...type, id: undefined }))),
    objectTypes: ir.objectTypes.map((type) => ({
        ...set(type, objectTypeId({ ...type, id: undefined })),
        properties: type.properties.map((property) =>
            set(property, propertyId({ ...property, id: undefined }))
        ),
    })),
    linkTypes: ir.linkTypes.map((link) => set(link, linkTypeId({ ...link, id: undefined }))),
    actionTypes: ir.actionTypes.map((type) => set(type, actionTypeId({ ...type, id: undefined }))),
    queryFunctionTypes: ir.queryFunctionTypes.map((type) =>
        set(type, queryFunctionTypeId({ ...type, id: undefined }))
    ),
});

/** Give every definition its id, filling in defaults: the form a definition takes as meta rows. */
export const withDefinitionIds = (ir: OntologyIR): OntologyIR =>
    mapIds(ir, (node, fallback) => withId(node, node.id ?? fallback));

/** Drop ids that equal their default, so a definition read back from meta rows matches the one it
 * was written from. Provider ids are kept. */
export const withoutDefaultIds = (ir: OntologyIR): OntologyIR => mapIds(ir, withoutDefault);
