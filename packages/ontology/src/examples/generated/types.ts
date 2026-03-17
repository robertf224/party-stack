// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

export type Address = {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
};
export type Author = {
    authorId: string;
    name: string;
    email: string;
    bio?: string;
    avatar?: v.attachment;
    address?: Address;
    createdAt: v.timestamp;
};
export type Post = {
    postId: string;
    title: string;
    body: string;
    authorId: string;
    status: "draft" | "published" | "archived";
    coverImage?: v.attachment;
    tags: Array<string>;
    createdAt: v.timestamp;
    publishedAt?: v.timestamp;
};
export type Comment = {
    commentId: string;
    body: string;
    postId: string;
    authorId: string;
    createdAt: v.timestamp;
};
export type BlogOntology = {
    objectTypes: {
        Author: Author;
        Post: Post;
        Comment: Comment;
    };
};
