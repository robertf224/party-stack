import type { OntologyIR } from "@party-stack/ontology";

export function projectTaskManagerOntology(ontology: OntologyIR): OntologyIR {
    const selectedProperties = new Map([
        [
            "Task",
            new Set([
                "Id",
                "Subject",
                "ActivityDate",
                "Status",
                "Priority",
                "OwnerId",
                "Description",
                "IsClosed",
                "CreatedDate",
                "CreatedById",
                "LastModifiedDate",
                "LastModifiedById",
            ]),
        ],
        ["User", new Set(["Id", "Name", "Username", "Email"])],
    ]);
    return {
        ...ontology,
        objectTypes: ontology.objectTypes.map((objectType) => {
            const selected = selectedProperties.get(objectType.name);
            return selected
                ? {
                      ...objectType,
                      properties: objectType.properties.filter((property) => selected.has(property.name)),
                  }
                : objectType;
        }),
        linkTypes: ontology.linkTypes.filter((linkType) => {
            const selected = selectedProperties.get(linkType.source.objectType);
            return !selected || selected.has(linkType.foreignKey);
        }),
    };
}
