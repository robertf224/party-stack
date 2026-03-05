// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

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
    avatar?: v.attachment;
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
    coverImage?: v.attachment;
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

export type OntologyObjectTypeName = "Author" | "Post" | "Comment";
export type OntologyByObjectType = {
    Author: Author;
    Post: Post;
    Comment: Comment;
};
export type OntologyObject = OntologyByObjectType[OntologyObjectTypeName];

export type BlogLinkMap = {
    Author: Record<string, never>;
    Post: {
        posts: { target: Author; targetKey: Author["authorId"] };
    };
    Comment: {
        comments: { target: Post; targetKey: Post["postId"] };
        comment: { target: Author; targetKey: Author["authorId"] };
    };
};
