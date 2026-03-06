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
    Author: {
        posts: {
            source: {
                object: Author;
                name: "author";
            };
            target: {
                object: Post;
                name: "posts";
            };
            targetKey: Post["postId"];
        };
        comment: {
            source: {
                object: Author;
                name: "author";
            };
            target: {
                object: Comment;
                name: "comment";
            };
            targetKey: Comment["commentId"];
        };
    };
    Post: {
        author: {
            source: {
                object: Post;
                name: "posts";
            };
            target: {
                object: Author;
                name: "author";
            };
            targetKey: Author["authorId"];
        };
        comments: {
            source: {
                object: Post;
                name: "post";
            };
            target: {
                object: Comment;
                name: "comments";
            };
            targetKey: Comment["commentId"];
        };
    };
    Comment: {
        post: {
            source: {
                object: Comment;
                name: "comments";
            };
            target: {
                object: Post;
                name: "post";
            };
            targetKey: Post["postId"];
        };
        author: {
            source: {
                object: Comment;
                name: "comment";
            };
            target: {
                object: Author;
                name: "author";
            };
            targetKey: Author["authorId"];
        };
    };
};
