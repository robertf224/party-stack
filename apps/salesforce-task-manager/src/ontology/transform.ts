import {
    o,
    type OntologyIR,
    type TypeDef,
} from "@party-stack/ontology";

function taskPropertyType(
    ontology: OntologyIR,
    propertyName: string,
    fallback: TypeDef
): TypeDef {
    return (
        ontology.objectTypes
            .find(
                (objectType) =>
                    objectType.name === "Task"
            )
            ?.properties.find(
                (property) =>
                    property.name === propertyName
            )?.type ?? fallback
    );
}

export function addTaskManagerActions(
    ontology: OntologyIR
): OntologyIR {
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
        [
            "User",
            new Set([
                "Id",
                "Name",
                "Username",
                "Email",
            ]),
        ],
    ]);
    const projected: OntologyIR = {
        ...ontology,
        objectTypes: ontology.objectTypes.map(
            (objectType) => {
                const selected =
                    selectedProperties.get(
                        objectType.name
                    );
                return selected
                    ? {
                          ...objectType,
                          properties:
                              objectType.properties.filter(
                                  (property) =>
                                      selected.has(
                                          property.name
                                      )
                              ),
                      }
                    : objectType;
            }
        ),
        linkTypes: ontology.linkTypes.filter(
            (linkType) => {
                const selected =
                    selectedProperties.get(
                        linkType.source.objectType
                    );
                return (
                    !selected ||
                    selected.has(linkType.foreignKey)
                );
            }
        ),
    };
    const status = taskPropertyType(
        projected,
        "Status",
        o.string({})
    );
    const priority = taskPropertyType(
        projected,
        "Priority",
        o.string({})
    );
    const activityDate = taskPropertyType(
        projected,
        "ActivityDate",
        o.optional({
            type: o.date({}),
        })
    );
    const writableFields = [
        {
            name: "subject",
            displayName: "Subject",
            type: o.string({}),
        },
        {
            name: "status",
            displayName: "Status",
            type: status,
        },
        {
            name: "priority",
            displayName: "Priority",
            type: priority,
        },
        {
            name: "activityDate",
            displayName: "Due date",
            type: activityDate,
        },
    ];

    return {
        ...projected,
        actionTypes: [
            ...projected.actionTypes,
            {
                name: "createTask",
                displayName: "Create task",
                parameters: writableFields,
                logic: [],
            },
            {
                name: "updateTask",
                displayName: "Update task",
                parameters: [
                    {
                        name: "task",
                        displayName: "Task",
                        type: o.objectReference({
                            objectType: "Task",
                        }),
                    },
                    ...writableFields,
                ],
                logic: [],
            },
            {
                name: "deleteTask",
                displayName: "Delete task",
                parameters: [
                    {
                        name: "task",
                        displayName: "Task",
                        type: o.objectReference({
                            objectType: "Task",
                        }),
                    },
                ],
                logic: [],
            },
        ],
    };
}
