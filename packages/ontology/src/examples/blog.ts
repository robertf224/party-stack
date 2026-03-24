/**
 * Example: Blog ontology with Authors, Posts, and Comments.
 *
 * Demonstrates:
 * - Object types with primary keys and typed properties
 * - Value types (reusable structured types)
 * - Link types with cardinality
 * - Attachment properties (e.g. author avatar)
 * - String enum constraints (e.g. post status)
 * - Optional properties and timestamps
 */

import { o } from "../ir/generated/builders.js";
import type { OntologyIR } from "../ir/generated/types.js";

export default {
    types: [
        {
            name: "Address",
            description: "A mailing address.",
            type: o.struct({
                fields: [
                    { name: "line1", displayName: "Line 1", type: o.string({}) },
                    {
                        name: "line2",
                        displayName: "Line 2",
                        type: o.optional({ type: o.string({}) }),
                    },
                    { name: "city", displayName: "City", type: o.string({}) },
                    { name: "state", displayName: "State", type: o.string({}) },
                    { name: "zip", displayName: "ZIP", type: o.string({}) },
                ],
            }),
        },
    ],

    objectTypes: [
        {
            name: "Author",
            displayName: "Author",
            pluralDisplayName: "Authors",
            description: "A blog author.",
            primaryKey: "authorId",
            properties: [
                {
                    name: "authorId",
                    displayName: "Author ID",
                    type: o.string({}),
                },
                {
                    name: "name",
                    displayName: "Name",
                    type: o.string({}),
                },
                {
                    name: "email",
                    displayName: "Email",
                    type: o.string({}),
                },
                {
                    name: "bio",
                    displayName: "Bio",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "avatar",
                    displayName: "Avatar",
                    description: "The author's profile picture.",
                    type: o.optional({ type: o.attachment({}) }),
                },
                {
                    name: "address",
                    displayName: "Address",
                    type: o.optional({ type: o.ref({ name: "Address" }) }),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
            ],
        },
        {
            name: "Post",
            displayName: "Blog Post",
            pluralDisplayName: "Posts",
            description: "A blog post.",
            primaryKey: "postId",
            properties: [
                {
                    name: "postId",
                    displayName: "Post ID",
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
                    name: "authorId",
                    displayName: "Author ID",
                    type: o.string({}),
                },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "draft", label: "Draft" },
                                { value: "published", label: "Published" },
                                { value: "archived", label: "Archived" },
                            ],
                        }),
                    }),
                },
                {
                    name: "coverImage",
                    displayName: "Cover Image",
                    type: o.optional({ type: o.attachment({}) }),
                },
                {
                    name: "tags",
                    displayName: "Tags",
                    type: o.list({ elementType: o.string({}) }),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
                {
                    name: "publishedAt",
                    displayName: "Published At",
                    type: o.optional({ type: o.timestamp({}) }),
                },
            ],
        },
        {
            name: "Comment",
            displayName: "Comment",
            pluralDisplayName: "Comments",
            description: "A comment on a blog post.",
            primaryKey: "commentId",
            properties: [
                {
                    name: "commentId",
                    displayName: "Comment ID",
                    type: o.string({}),
                },
                {
                    name: "body",
                    displayName: "Body",
                    type: o.string({}),
                },
                {
                    name: "postId",
                    displayName: "Post ID",
                    type: o.string({}),
                },
                {
                    name: "authorId",
                    displayName: "Author ID",
                    type: o.string({}),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
            ],
        },
    ],

    linkTypes: [
        {
            id: "Post:author",
            source: {
                objectType: "Post",
                name: "posts",
                displayName: "Posts",
            },
            target: {
                objectType: "Author",
                name: "author",
                displayName: "Author",
            },
            foreignKey: "authorId",
            cardinality: "many",
        },
        {
            id: "Comment:post",
            source: {
                objectType: "Comment",
                name: "comments",
                displayName: "Comments",
            },
            target: {
                objectType: "Post",
                name: "post",
                displayName: "Post",
            },
            foreignKey: "postId",
            cardinality: "many",
        },
        {
            id: "Comment:author",
            source: {
                objectType: "Comment",
                name: "comment",
                displayName: "Comment",
            },
            target: {
                objectType: "Author",
                name: "author",
                displayName: "Author",
            },
            foreignKey: "authorId",
            cardinality: "one",
        },
    ],
    actionTypes: [
        {
            name: "createPost",
            displayName: "Create Post",
            description: "Create a new blog post.",
            parameters: [
                {
                    name: "postId",
                    displayName: "Post ID",
                    type: o.string({}),
                    defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                },
                {
                    name: "author",
                    displayName: "Author",
                    type: o.objectReference({ objectType: "Author" }),
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
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "draft", label: "Draft" },
                                { value: "published", label: "Published" },
                                { value: "archived", label: "Archived" },
                            ],
                        }),
                    }),
                },
                {
                    name: "tags",
                    displayName: "Tags",
                    type: o.list({ elementType: o.string({}) }),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                    defaultValue: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Post",
                    values: [
                        {
                            property: ["postId"],
                            value: o.Expression.valueReference({ path: ["postId"] }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({ path: ["title"] }),
                        },
                        {
                            property: ["body"],
                            value: o.Expression.valueReference({ path: ["body"] }),
                        },
                        {
                            property: ["authorId"],
                            value: o.Expression.valueReference({ path: ["author", "authorId"] }),
                        },
                        {
                            property: ["status"],
                            value: o.Expression.valueReference({ path: ["status"] }),
                        },
                        {
                            property: ["tags"],
                            value: o.Expression.valueReference({ path: ["tags"] }),
                        },
                        {
                            property: ["createdAt"],
                            value: o.Expression.valueReference({ path: ["createdAt"] }),
                        },
                    ],
                }),
            ],
        },
    ],
} satisfies OntologyIR;
