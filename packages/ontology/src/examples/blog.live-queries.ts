/**
 * Example live queries using generated ontology object sources.
 */
import { Query, concat, createCollection, eq, liveQueryCollectionOptions } from "@tanstack/db";
import { createBlogLiveOntology } from "./generated/live.js";
import type { OntologyAdapter } from "../live/OntologyAdapter.js";

declare const adapter: OntologyAdapter;

const blog = createBlogLiveOntology(adapter);
const { Post, Author, Comment } = blog.objects;

const postList = createCollection(
    liveQueryCollectionOptions({
        query: new Query().from({ Post }).select(({ Post }) => ({
            postId: Post.postId,
            title: Post.title,
            status: Post.status,
        })),
    })
);

const postListWithAuthor = createCollection(
    liveQueryCollectionOptions({
        query: new Query()
            .from({ Post })
            .leftJoin({ Author }, ({ Post, Author }) => eq(Post.authorId, Author.authorId))
            .select(({ Post, Author }) => ({
                postId: Post.postId,
                title: Post.title,
                authorName: Author?.name,
            })),
    })
);

const commentFeed = createCollection(
    liveQueryCollectionOptions({
        query: new Query()
            .from({ Comment })
            .leftJoin({ Post }, ({ Comment, Post }) => eq(Comment.postId, Post.postId))
            .leftJoin({ Author }, ({ Comment, Author }) => eq(Comment.authorId, Author.authorId))
            .where(({ Post }) => eq(Post?.status, "published"))
            .select(({ Comment, Post, Author }) => ({
                commentId: Comment.commentId,
                body: Comment.body,
                postTitle: Post?.title,
                authorDisplay: concat(Author?.name, " <", Author?.email, ">"),
            })),
    })
);

export const postCollection = Post;
export const authorCollection = Author;
export const commentCollection = Comment;

void postList;
void postListWithAuthor;
void commentFeed;
