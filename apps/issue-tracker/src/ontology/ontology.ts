// Auto-generated file - do not edit manually

import { defineOntology, o } from "@party-stack/ontology";
export default defineOntology({
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                {
                    name: "createdAt",
                    displayName: "Created at",
                    type: o.timestamp({}),
                },
                {
                    name: "completedAt",
                    displayName: "Completed at",
                    type: o.timestamp({}),
                },
                {
                    name: "attachments",
                    displayName: "Attachments",
                    type: o.list({
                        elementType: o.attachment({
                            meta: {
                                type: "attachment",
                            },
                        }),
                    }),
                },
                {
                    name: "createdBy",
                    displayName: "Created by",
                    type: o.string({}),
                },
                {
                    name: "location",
                    displayName: "Location",
                    type: o.geopoint({}),
                },
                {
                    name: "id",
                    displayName: "Id",
                    type: o.string({}),
                },
                {
                    name: "media",
                    displayName: "Media",
                    type: o.attachment({
                        meta: {
                            type: "media",
                        },
                    }),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "completedBy",
                    displayName: "Completed by",
                    type: o.string({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "completeTask",
            displayName: "Complete Task",
            parameters: [
                {
                    name: "task",
                    displayName: "Task",
                    type: o.objectReference({
                        objectType: "Task",
                    }),
                },
                {
                    name: "__now",
                    displayName: "Current time",
                    type: o.timestamp({}),
                    defaultValue: o.Expression.functionCall({
                        kind: "now",
                        value: {},
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: {
                        path: ["task"],
                    },
                    values: [
                        {
                            property: ["completedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                    ],
                }),
            ],
        },
        {
            name: "createTask",
            displayName: "Create Task",
            parameters: [
                {
                    name: "attachments",
                    displayName: "Attachments",
                    type: o.optional({
                        type: o.list({
                            elementType: o.attachment({
                                meta: {
                                    type: "attachment",
                                },
                            }),
                        }),
                    }),
                },
                {
                    name: "location",
                    displayName: "Location",
                    type: o.optional({
                        type: o.geopoint({}),
                    }),
                },
                {
                    name: "media",
                    displayName: "Media",
                    type: o.optional({
                        type: o.attachment({
                            meta: {
                                type: "media",
                            },
                        }),
                    }),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef",
                    displayName: "Generated UUID 1",
                    type: o.string({}),
                    defaultValue: o.Expression.functionCall({
                        kind: "uuid",
                        value: {},
                    }),
                },
                {
                    name: "__now",
                    displayName: "Current time",
                    type: o.timestamp({}),
                    defaultValue: o.Expression.functionCall({
                        kind: "now",
                        value: {},
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Task",
                    values: [
                        {
                            property: ["createdAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["attachments"],
                            value: o.Expression.valueReference({
                                path: ["attachments"],
                            }),
                        },
                        {
                            property: ["createdBy"],
                            value: o.Expression.contextReference({
                                path: ["userId"],
                            }),
                        },
                        {
                            property: ["location"],
                            value: o.Expression.valueReference({
                                path: ["location"],
                            }),
                        },
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef"],
                            }),
                        },
                        {
                            property: ["media"],
                            value: o.Expression.valueReference({
                                path: ["media"],
                            }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                    ],
                }),
            ],
        },
        {
            name: "deleteTask",
            displayName: "Delete Task",
            parameters: [
                {
                    name: "task",
                    displayName: "Task",
                    type: o.objectReference({
                        objectType: "Task",
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.deleteObject({
                    object: {
                        path: ["task"],
                    },
                }),
            ],
        },
        {
            name: "reopenTask",
            displayName: "Reopen task",
            parameters: [
                {
                    name: "completedAt",
                    displayName: "Completed at",
                    type: o.optional({
                        type: o.timestamp({}),
                    }),
                },
                {
                    name: "task",
                    displayName: "Task",
                    type: o.objectReference({
                        objectType: "Task",
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: {
                        path: ["task"],
                    },
                    values: [
                        {
                            property: ["completedAt"],
                            value: o.Expression.valueReference({
                                path: ["completedAt"],
                            }),
                        },
                    ],
                }),
            ],
        },
        {
            name: "streamlineCreateToken",
            displayName: "[Streamline] Create Token",
            parameters: [
                {
                    name: "contextObjectId",
                    displayName: "Context object id",
                    type: o.string({}),
                },
                {
                    name: "tokenTypeId",
                    displayName: "Token type id",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "allowedFormIds",
                    displayName: "Allowed form ids",
                    type: o.list({
                        elementType: o.string({}),
                    }),
                },
                {
                    name: "name",
                    displayName: "Name",
                    type: o.string({}),
                },
                {
                    name: "secretHash",
                    displayName: "Secret hash",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "hashingAlgorithm",
                    displayName: "Hashing algorithm",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "expiresAt",
                    displayName: "Expires at",
                    type: o.optional({
                        type: o.timestamp({}),
                    }),
                },
            ],
            logic: [],
        },
    ],
    queryFunctionTypes: [
        {
            name: "googleMapsAutocompleteAddress",
            displayName: "googleMapsAutocompleteAddress",
            parameters: [
                {
                    name: "apiKey",
                    displayName: "apiKey",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "query",
                    displayName: "query",
                    type: o.string({}),
                },
                {
                    name: "sessionToken",
                    displayName: "sessionToken",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "countries",
                    displayName: "countries",
                    type: o.optional({
                        type: o.list({
                            elementType: o.string({}),
                        }),
                    }),
                },
            ],
            returnType: o.list({
                elementType: o.struct({
                    fields: [
                        {
                            name: "id",
                            displayName: "id",
                            type: o.string({}),
                        },
                        {
                            name: "label",
                            displayName: "label",
                            type: o.string({}),
                        },
                        {
                            name: "address",
                            displayName: "address",
                            type: o.optional({
                                type: o.struct({
                                    fields: [
                                        {
                                            name: "address",
                                            displayName: "address",
                                            type: o.string({}),
                                        },
                                        {
                                            name: "address2",
                                            displayName: "address2",
                                            type: o.optional({
                                                type: o.string({}),
                                            }),
                                        },
                                        {
                                            name: "city",
                                            displayName: "city",
                                            type: o.string({}),
                                        },
                                        {
                                            name: "state",
                                            displayName: "state",
                                            type: o.optional({
                                                type: o.string({}),
                                            }),
                                        },
                                        {
                                            name: "postalCode",
                                            displayName: "postalCode",
                                            type: o.string({}),
                                        },
                                        {
                                            name: "country",
                                            displayName: "country",
                                            type: o.string({}),
                                        },
                                    ],
                                }),
                            }),
                        },
                    ],
                }),
            }),
        },
        {
            name: "googleMapsGetAddress",
            displayName: "googleMapsGetAddress",
            parameters: [
                {
                    name: "apiKey",
                    displayName: "apiKey",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "sessionToken",
                    displayName: "sessionToken",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "id",
                    displayName: "id",
                    type: o.string({}),
                },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "address",
                        displayName: "address",
                        type: o.struct({
                            fields: [
                                {
                                    name: "address",
                                    displayName: "address",
                                    type: o.string({}),
                                },
                                {
                                    name: "address2",
                                    displayName: "address2",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "city",
                                    displayName: "city",
                                    type: o.string({}),
                                },
                                {
                                    name: "state",
                                    displayName: "state",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "postalCode",
                                    displayName: "postalCode",
                                    type: o.string({}),
                                },
                                {
                                    name: "country",
                                    displayName: "country",
                                    type: o.string({}),
                                },
                            ],
                        }),
                    },
                ],
            }),
        },
    ],
});
