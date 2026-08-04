import { o, type OntologyIR } from "@party-stack/ontology";

export const journalOntology = {
    types: [],
    objectTypes: [
        {
            name: "JournalEntry",
            displayName: "Journal Entry",
            pluralDisplayName: "Journal Entries",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "body",
                    displayName: "Body",
                    type: o.string({}),
                },
                {
                    name: "mood",
                    displayName: "Mood",
                    type: o.string({}),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
                {
                    name: "updatedAt",
                    displayName: "Updated At",
                    type: o.timestamp({}),
                },
            ],
        },
        {
            name: "JournalAttachment",
            displayName: "Journal Attachment",
            pluralDisplayName: "Journal Attachments",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "entryId",
                    displayName: "Entry ID",
                    type: o.string({}),
                },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createEntry",
            displayName: "Create Entry",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "body",
                    displayName: "Body",
                    type: o.string({}),
                },
                {
                    name: "mood",
                    displayName: "Mood",
                    type: o.string({}),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "JournalEntry",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["id"],
                            }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({
                                path: ["title"],
                            }),
                        },
                        {
                            property: ["body"],
                            value: o.Expression.valueReference({
                                path: ["body"],
                            }),
                        },
                        {
                            property: ["mood"],
                            value: o.Expression.valueReference({
                                path: ["mood"],
                            }),
                        },
                        {
                            property: ["createdAt"],
                            value: o.Expression.functionCall(
                                o.FunctionCallExpression.now({})
                            ),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(
                                o.FunctionCallExpression.now({})
                            ),
                        },
                    ],
                }),
            ],
        },
        {
            name: "deleteEntry",
            displayName: "Delete Entry",
            parameters: [
                {
                    name: "entry",
                    displayName: "Entry",
                    type: o.objectReference({
                        objectType: "JournalEntry",
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.deleteObject({
                    object: { path: ["entry"] },
                }),
            ],
        },
        {
            name: "attachFile",
            displayName: "Attach File",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "entry",
                    displayName: "Entry",
                    type: o.objectReference({
                        objectType: "JournalEntry",
                    }),
                },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "JournalAttachment",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({
                                path: ["id"],
                            }),
                        },
                        {
                            property: ["entryId"],
                            value: o.Expression.valueReference({
                                path: ["entry"],
                            }),
                        },
                        {
                            property: ["attachment"],
                            value: o.Expression.valueReference({
                                path: ["attachment"],
                            }),
                        },
                        {
                            property: ["createdAt"],
                            value: o.Expression.functionCall(
                                o.FunctionCallExpression.now({})
                            ),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [],
} satisfies OntologyIR;
