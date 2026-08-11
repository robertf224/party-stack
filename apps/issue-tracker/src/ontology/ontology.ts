// Auto-generated file - do not edit manually

import { defineOntology, o } from "@party-stack/ontology";
export default defineOntology({
    types: [],
    objectTypes: [
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "issueId",
            title: "issueTitle",
            properties: [
                {
                    name: "issueCompletedAt",
                    displayName: "Issue Completed At",
                    type: o.timestamp({}),
                    description:
                        "Timestamp when the issue entered the Completed state; empty while the issue is not completed.",
                },
                {
                    name: "issueStatus",
                    displayName: "Issue Status",
                    type: o.string({}),
                    description:
                        "Current workflow state of the issue: Open, In Progress, Waiting, or Completed.",
                },
                {
                    name: "issueUpdatedAt",
                    displayName: "Issue Updated At",
                    type: o.timestamp({}),
                    description: "Timestamp of the most recent update made to the issue.",
                },
                {
                    name: "issueId",
                    displayName: "Issue ID",
                    type: o.string({}),
                    description: "Stable system-generated identifier for an issue.",
                },
                {
                    name: "issueTitle",
                    displayName: "Issue Title",
                    type: o.string({}),
                    description:
                        "Short, human-readable summary used to identify the issue in lists and workflows.",
                },
                {
                    name: "issueAttachments",
                    displayName: "Issue Attachments",
                    type: o.list({
                        elementType: o.attachment({
                            meta: {
                                type: "attachment",
                            },
                            constraint: {
                                content: {
                                    kind: "image",
                                    value: {
                                        mediaTypes: ["image/png", "image/jpeg"],
                                    },
                                },
                            },
                        }),
                    }),
                    description: "Files that provide supporting material or evidence for the issue.",
                },
                {
                    name: "projectId",
                    displayName: "Project ID",
                    type: o.string({}),
                    description: "Identifier of the optional project that groups this issue.",
                },
                {
                    name: "issueCreatedAt",
                    displayName: "Issue Created At",
                    type: o.timestamp({}),
                    description: "Timestamp when the issue was created through the operational workflow.",
                },
                {
                    name: "issueDescription",
                    displayName: "Issue Description",
                    type: o.string({}),
                    description:
                        "Detailed context, requirements, or notes explaining the work represented by the issue.",
                },
            ],
            description:
                "A tracked unit of work that can optionally belong to a project and progress through a simple status lifecycle.",
        },
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "projectId",
            title: "projectTitle",
            properties: [
                {
                    name: "projectUpdatedAt",
                    displayName: "Project Updated At",
                    type: o.timestamp({}),
                    description: "Timestamp of the most recent update made to the project.",
                },
                {
                    name: "projectDescription",
                    displayName: "Project Description",
                    type: o.string({}),
                    description: "Summary of the project's purpose, scope, or intended outcome.",
                },
                {
                    name: "projectColor",
                    displayName: "Project Color",
                    type: o.string({}),
                    description:
                        "Display color used to visually distinguish the project, stored as a hexadecimal color value such as #2D72D2.",
                },
                {
                    name: "projectId",
                    displayName: "Project ID",
                    type: o.string({}),
                    description: "Stable system-generated identifier for a project.",
                },
                {
                    name: "projectCreatedAt",
                    displayName: "Project Created At",
                    type: o.timestamp({}),
                    description: "Timestamp when the project was created through the operational workflow.",
                },
                {
                    name: "projectTitle",
                    displayName: "Project Title",
                    type: o.string({}),
                    description: "Short, human-readable name used to identify the project.",
                },
            ],
            description:
                "A collection of related issues organized around a shared objective or body of work.",
        },
    ],
    linkTypes: [
        {
            id: "ri.ontology.main.relation.0a932a4d-9f7d-4874-980c-ef326adbc825",
            source: {
                objectType: "Project",
                name: "project",
                displayName: "Project",
            },
            target: {
                objectType: "Issue",
                name: "issues",
                displayName: "Issue",
            },
            foreignKey: "projectId",
            cardinality: "one",
        },
    ],
    actionTypes: [
        {
            name: "createIssue",
            displayName: "Create Issue",
            parameters: [
                {
                    name: "completedAt",
                    displayName: "Issue Completed At",
                    type: o.optional({
                        type: o.timestamp({}),
                    }),
                    description: "Completion timestamp when the issue is already completed.",
                },
                {
                    name: "attachments",
                    displayName: "Issue Attachments",
                    type: o.optional({
                        type: o.list({
                            elementType: o.attachment({
                                meta: {
                                    type: "attachment",
                                },
                                constraint: {
                                    content: {
                                        kind: "image",
                                        value: {
                                            mediaTypes: ["image/png", "image/jpeg"],
                                        },
                                    },
                                },
                            }),
                        }),
                    }),
                    description: "Optional files that support or explain the issue.",
                },
                {
                    name: "project",
                    displayName: "Project",
                    type: o.optional({
                        type: o.objectReference({
                            objectType: "Project",
                        }),
                    }),
                    description: "Optional project used to group the issue.",
                },
                {
                    name: "description",
                    displayName: "Issue Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description: "Detailed context or requirements for the issue.",
                },
                {
                    name: "title",
                    displayName: "Issue Title",
                    type: o.string({}),
                    description: "Short summary of the issue.",
                },
                {
                    name: "status",
                    displayName: "Issue Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "Open",
                                    label: "Open",
                                },
                                {
                                    value: "In Progress",
                                    label: "In Progress",
                                },
                                {
                                    value: "Waiting",
                                    label: "Waiting",
                                },
                                {
                                    value: "Completed",
                                    label: "Completed",
                                },
                            ],
                        }),
                    }),
                    description: "Initial workflow state for the issue.",
                },
                {
                    name: "__uuid_0df17cad-fc40-4f4b-b755-dfccb968d615",
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
                    objectType: "Issue",
                    values: [
                        {
                            property: ["issueCompletedAt"],
                            value: o.Expression.valueReference({
                                path: ["completedAt"],
                            }),
                        },
                        {
                            property: ["issueStatus"],
                            value: o.Expression.valueReference({
                                path: ["status"],
                            }),
                        },
                        {
                            property: ["issueUpdatedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["issueId"],
                            value: o.Expression.valueReference({
                                path: ["__uuid_0df17cad-fc40-4f4b-b755-dfccb968d615"],
                            }),
                        },
                        {
                            property: ["issueTitle"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                        {
                            property: ["issueAttachments"],
                            value: o.Expression.valueReference({
                                path: ["attachments"],
                            }),
                        },
                        {
                            property: ["projectId"],
                            value: o.Expression.valueReference({
                                path: ["project", "projectId"],
                            }),
                        },
                        {
                            property: ["issueCreatedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["issueDescription"],
                            value: o.Expression.valueReference({
                                path: ["description"],
                            }),
                        },
                    ],
                }),
            ],
            description:
                "Creates an issue with a generated identifier and system-managed creation and update timestamps.",
        },
        {
            name: "createProject",
            displayName: "Create Project",
            parameters: [
                {
                    name: "color",
                    displayName: "Project Color",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.regex({
                                regex: "^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$",
                            }),
                        }),
                    }),
                    description: "Optional hexadecimal display color, such as #2D72D2.",
                },
                {
                    name: "description",
                    displayName: "Project Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description: "Summary of the project's purpose and scope.",
                },
                {
                    name: "title",
                    displayName: "Project Title",
                    type: o.string({}),
                    description: "Human-readable project name.",
                },
                {
                    name: "__uuid_7af1b7e1-9b8f-470d-bcf1-e02376d353c1",
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
                    objectType: "Project",
                    values: [
                        {
                            property: ["projectUpdatedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["projectDescription"],
                            value: o.Expression.valueReference({
                                path: ["description"],
                            }),
                        },
                        {
                            property: ["projectColor"],
                            value: o.Expression.valueReference({
                                path: ["color"],
                            }),
                        },
                        {
                            property: ["projectId"],
                            value: o.Expression.valueReference({
                                path: ["__uuid_7af1b7e1-9b8f-470d-bcf1-e02376d353c1"],
                            }),
                        },
                        {
                            property: ["projectCreatedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["projectTitle"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                    ],
                }),
            ],
            description:
                "Creates a project with a generated identifier and system-managed creation and update timestamps.",
        },
        {
            name: "deleteIssue",
            displayName: "Delete Issue",
            parameters: [
                {
                    name: "issue",
                    displayName: "Issue",
                    type: o.objectReference({
                        objectType: "Issue",
                    }),
                    description: "Issue to permanently delete.",
                },
            ],
            logic: [
                o.ActionLogicStep.deleteObject({
                    object: {
                        path: ["issue"],
                    },
                }),
            ],
            description: "Permanently deletes a selected issue.",
        },
        {
            name: "deleteProject",
            displayName: "Delete Project",
            parameters: [
                {
                    name: "project",
                    displayName: "Project",
                    type: o.objectReference({
                        objectType: "Project",
                    }),
                    description: "Project to permanently delete.",
                },
            ],
            logic: [
                o.ActionLogicStep.deleteObject({
                    object: {
                        path: ["project"],
                    },
                }),
            ],
            description: "Permanently deletes a selected project. Existing issues are not deleted.",
        },
        {
            name: "updateIssue",
            displayName: "Update Issue",
            parameters: [
                {
                    name: "completedAt",
                    displayName: "Issue Completed At",
                    type: o.optional({
                        type: o.timestamp({}),
                    }),
                    description: "Completion timestamp; clear this value when the issue is not completed.",
                },
                {
                    name: "attachments",
                    displayName: "Issue Attachments",
                    type: o.optional({
                        type: o.list({
                            elementType: o.attachment({
                                meta: {
                                    type: "attachment",
                                },
                                constraint: {
                                    content: {
                                        kind: "image",
                                        value: {
                                            mediaTypes: ["image/png", "image/jpeg"],
                                        },
                                    },
                                },
                            }),
                        }),
                    }),
                    description: "Files that support or explain the issue.",
                },
                {
                    name: "issue",
                    displayName: "Issue",
                    type: o.objectReference({
                        objectType: "Issue",
                    }),
                    description: "Issue to update.",
                },
                {
                    name: "description",
                    displayName: "Issue Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description: "Detailed context or requirements for the issue.",
                },
                {
                    name: "project",
                    displayName: "Project",
                    type: o.optional({
                        type: o.objectReference({
                            objectType: "Project",
                        }),
                    }),
                    description: "Optional project used to group the issue.",
                },
                {
                    name: "title",
                    displayName: "Issue Title",
                    type: o.string({}),
                    description: "Short summary of the issue.",
                },
                {
                    name: "status",
                    displayName: "Issue Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "Open",
                                    label: "Open",
                                },
                                {
                                    value: "In Progress",
                                    label: "In Progress",
                                },
                                {
                                    value: "Waiting",
                                    label: "Waiting",
                                },
                                {
                                    value: "Completed",
                                    label: "Completed",
                                },
                            ],
                        }),
                    }),
                    description: "New workflow state for the issue.",
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
                        path: ["issue"],
                    },
                    values: [
                        {
                            property: ["issueCompletedAt"],
                            value: o.Expression.valueReference({
                                path: ["completedAt"],
                            }),
                        },
                        {
                            property: ["issueStatus"],
                            value: o.Expression.valueReference({
                                path: ["status"],
                            }),
                        },
                        {
                            property: ["issueUpdatedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["issueTitle"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                        {
                            property: ["issueAttachments"],
                            value: o.Expression.valueReference({
                                path: ["attachments"],
                            }),
                        },
                        {
                            property: ["projectId"],
                            value: o.Expression.valueReference({
                                path: ["project", "projectId"],
                            }),
                        },
                        {
                            property: ["issueDescription"],
                            value: o.Expression.valueReference({
                                path: ["description"],
                            }),
                        },
                    ],
                }),
            ],
            description:
                "Updates an issue's details, workflow state, optional project, attachments, and completion timestamp while refreshing its update timestamp.",
        },
        {
            name: "updateProject",
            displayName: "Update Project",
            parameters: [
                {
                    name: "color",
                    displayName: "Project Color",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.regex({
                                regex: "^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$",
                            }),
                        }),
                    }),
                    description: "Optional hexadecimal display color, such as #2D72D2.",
                },
                {
                    name: "project",
                    displayName: "Project",
                    type: o.objectReference({
                        objectType: "Project",
                    }),
                    description: "Project to update.",
                },
                {
                    name: "description",
                    displayName: "Project Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description: "Summary of the project's purpose and scope.",
                },
                {
                    name: "title",
                    displayName: "Project Title",
                    type: o.string({}),
                    description: "Human-readable project name.",
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
                        path: ["project"],
                    },
                    values: [
                        {
                            property: ["projectUpdatedAt"],
                            value: o.Expression.valueReference({
                                path: ["__now"],
                            }),
                        },
                        {
                            property: ["projectDescription"],
                            value: o.Expression.valueReference({
                                path: ["description"],
                            }),
                        },
                        {
                            property: ["projectColor"],
                            value: o.Expression.valueReference({
                                path: ["color"],
                            }),
                        },
                        {
                            property: ["projectTitle"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                    ],
                }),
            ],
            description:
                "Updates a project's title, description, and display color while refreshing its update timestamp.",
        },
    ],
    queryFunctionTypes: [],
});
