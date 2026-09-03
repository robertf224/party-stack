// Auto-generated file - do not edit manually

import { defineOntology, o } from "@party-stack/ontology";
export default defineOntology({
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "Id",
            title: "Subject",
            properties: [
                {
                    name: "Id",
                    displayName: "Activity ID",
                    type: o.string({}),
                },
                {
                    name: "Subject",
                    displayName: "Subject",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "ActivityDate",
                    displayName: "Due Date Only",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "Status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "Not Started",
                                    label: "Not Started",
                                },
                                {
                                    value: "In Progress",
                                    label: "In Progress",
                                },
                                {
                                    value: "Completed",
                                    label: "Completed",
                                },
                                {
                                    value: "Waiting on someone else",
                                    label: "Waiting on someone else",
                                },
                                {
                                    value: "Deferred",
                                    label: "Deferred",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "Priority",
                    displayName: "Priority",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "High",
                                    label: "High",
                                },
                                {
                                    value: "Normal",
                                    label: "Normal",
                                },
                                {
                                    value: "Low",
                                    label: "Low",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "OwnerId",
                    displayName: "Assigned To ID",
                    type: o.string({}),
                },
                {
                    name: "Description",
                    displayName: "Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "IsClosed",
                    displayName: "Closed",
                    type: o.boolean({}),
                },
                {
                    name: "CreatedDate",
                    displayName: "Created Date",
                    type: o.timestamp({}),
                },
                {
                    name: "CreatedById",
                    displayName: "Created By ID",
                    type: o.objectReference({
                        objectType: "User",
                    }),
                },
                {
                    name: "LastModifiedDate",
                    displayName: "Last Modified Date",
                    type: o.timestamp({}),
                },
                {
                    name: "LastModifiedById",
                    displayName: "Last Modified By ID",
                    type: o.objectReference({
                        objectType: "User",
                    }),
                },
            ],
        },
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "Id",
            title: "Name",
            properties: [
                {
                    name: "Id",
                    displayName: "User ID",
                    type: o.string({}),
                },
                {
                    name: "Username",
                    displayName: "Username",
                    type: o.string({}),
                },
                {
                    name: "Name",
                    displayName: "Full Name",
                    type: o.string({}),
                },
                {
                    name: "Email",
                    displayName: "Email",
                    type: o.string({}),
                },
            ],
        },
    ],
    linkTypes: [
        {
            id: "salesforce:link:Task.CreatedById",
            source: {
                objectType: "Task",
                name: "tasks",
                displayName: "Tasks",
            },
            target: {
                objectType: "User",
                name: "CreatedBy",
                displayName: "Created By ID",
            },
            foreignKey: "CreatedById",
            cardinality: "many",
        },
        {
            id: "salesforce:link:Task.LastModifiedById",
            source: {
                objectType: "Task",
                name: "tasks",
                displayName: "Tasks",
            },
            target: {
                objectType: "User",
                name: "LastModifiedBy",
                displayName: "Last Modified By ID",
            },
            foreignKey: "LastModifiedById",
            cardinality: "many",
        },
    ],
    actionTypes: [
        {
            name: "createTask",
            displayName: "Create task",
            parameters: [
                {
                    name: "subject",
                    displayName: "Subject",
                    type: o.string({}),
                },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "Not Started",
                                    label: "Not Started",
                                },
                                {
                                    value: "In Progress",
                                    label: "In Progress",
                                },
                                {
                                    value: "Completed",
                                    label: "Completed",
                                },
                                {
                                    value: "Waiting on someone else",
                                    label: "Waiting on someone else",
                                },
                                {
                                    value: "Deferred",
                                    label: "Deferred",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "priority",
                    displayName: "Priority",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "High",
                                    label: "High",
                                },
                                {
                                    value: "Normal",
                                    label: "Normal",
                                },
                                {
                                    value: "Low",
                                    label: "Low",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "activityDate",
                    displayName: "Due date",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
            ],
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
                {
                    name: "subject",
                    displayName: "Subject",
                    type: o.string({}),
                },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "Not Started",
                                    label: "Not Started",
                                },
                                {
                                    value: "In Progress",
                                    label: "In Progress",
                                },
                                {
                                    value: "Completed",
                                    label: "Completed",
                                },
                                {
                                    value: "Waiting on someone else",
                                    label: "Waiting on someone else",
                                },
                                {
                                    value: "Deferred",
                                    label: "Deferred",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "priority",
                    displayName: "Priority",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "High",
                                    label: "High",
                                },
                                {
                                    value: "Normal",
                                    label: "Normal",
                                },
                                {
                                    value: "Low",
                                    label: "Low",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "activityDate",
                    displayName: "Due date",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
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
    queryFunctionTypes: [],
});
