// Auto-generated file - do not edit manually

import { o } from "@party-stack/ontology";
import type { OntologyIR } from "@party-stack/ontology";
export default {
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
                            property: ["createdBy"],
                            value: o.Expression.contextReference({
                                path: ["userId"],
                            }),
                        },
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef"],
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
    ],
} satisfies OntologyIR;
