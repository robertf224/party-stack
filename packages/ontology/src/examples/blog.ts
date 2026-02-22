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

import { o } from "../ir/builders.js";
import type { OntologyIR } from "../ir/types.js";

export const blogOntology = {
    valueTypes: [
        {
            apiName: "Address",
            displayName: "Address",
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
            apiName: "Author",
            displayName: "Author",
            description: "A blog author.",
            primaryKey: "authorId",
            properties: [
                {
                    apiName: "authorId",
                    displayName: "Author ID",
                    type: o.string({}),
                },
                {
                    apiName: "name",
                    displayName: "Name",
                    type: o.string({}),
                },
                {
                    apiName: "email",
                    displayName: "Email",
                    type: o.string({}),
                },
                {
                    apiName: "bio",
                    displayName: "Bio",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    apiName: "avatar",
                    displayName: "Avatar",
                    description: "The author's profile picture.",
                    type: o.optional({ type: o.attachment({}) }),
                },
                {
                    apiName: "address",
                    displayName: "Address",
                    type: o.optional({ type: o.ref({ name: "Address" }) }),
                },
                {
                    apiName: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
            ],
        },
        {
            apiName: "Post",
            displayName: "Blog Post",
            description: "A blog post.",
            primaryKey: "postId",
            properties: [
                {
                    apiName: "postId",
                    displayName: "Post ID",
                    type: o.string({}),
                },
                {
                    apiName: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    apiName: "body",
                    displayName: "Body",
                    type: o.string({}),
                },
                {
                    apiName: "status",
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
                    apiName: "coverImage",
                    displayName: "Cover Image",
                    type: o.optional({ type: o.attachment({}) }),
                },
                {
                    apiName: "tags",
                    displayName: "Tags",
                    type: o.list({ elementType: o.string({}) }),
                },
                {
                    apiName: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
                {
                    apiName: "publishedAt",
                    displayName: "Published At",
                    type: o.optional({ type: o.timestamp({}) }),
                },
            ],
        },
        {
            apiName: "Comment",
            displayName: "Comment",
            description: "A comment on a blog post.",
            primaryKey: "commentId",
            properties: [
                {
                    apiName: "commentId",
                    displayName: "Comment ID",
                    type: o.string({}),
                },
                {
                    apiName: "body",
                    displayName: "Body",
                    type: o.string({}),
                },
                {
                    apiName: "createdAt",
                    displayName: "Created At",
                    type: o.timestamp({}),
                },
            ],
        },
    ],

    linkTypes: [
        {
            apiName: "authorPosts",
            displayName: "Author Posts",
            description: "Posts written by an author.",
            sourceObjectType: "Author",
            targetObjectType: "Post",
            cardinality: "many" as const,
        },
        {
            apiName: "postComments",
            displayName: "Post Comments",
            description: "Comments on a post.",
            sourceObjectType: "Post",
            targetObjectType: "Comment",
            cardinality: "many" as const,
        },
        {
            apiName: "commentAuthor",
            displayName: "Comment Author",
            description: "The author of a comment.",
            sourceObjectType: "Comment",
            targetObjectType: "Author",
            cardinality: "one" as const,
        },
    ],
} satisfies OntologyIR;
