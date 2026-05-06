// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

export type attachment = {
    id: string;
    size?: v.double;
    type?: string;
    name?: string;
};

/** A mailing address. */
export type Address = {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
};

/** A blog author. */
export type Author = {
    authorId: string;
    name: string;
    email: string;
    bio?: string;
    /** The author's profile picture. */
    avatar?: attachment;
    address?: Address;
    createdAt: v.timestamp;
};

/** A blog post. */
export type Post = {
    postId: string;
    title: string;
    body: string;
    authorId: string;
    status: "draft" | "published" | "archived";
    coverImage?: attachment;
    tags: Array<string>;
    createdAt: v.timestamp;
    publishedAt?: v.timestamp;
};

/** A comment on a blog post. */
export type Comment = {
    commentId: string;
    body: string;
    postId: string;
    authorId: string;
    createdAt: v.timestamp;
};

/** Create a new blog post. */
export type CreatePostParameters = {
    postId?: string;
    author: string;
    title: string;
    body: string;
    status: "draft" | "published" | "archived";
    tags: Array<string>;
    createdAt?: v.timestamp;
};

export type BlogOntology = {
    objectTypes: {
        Author: Author;
        Post: Post;
        Comment: Comment;
    };
    actionTypes: {
        createPost: {
            parameters: CreatePostParameters;
        };
    };
};
