/**
 * Example live queries using the blog ontology.
 *
 * related(sourceAlias, relationshipName, joinAlias?) is provided on the wrapped query
 * builder (blog.query()). sourceAlias autocompletes from current query context aliases,
 * and relationshipName autocompletes from links on that source object's type.
 */
import { concat, createCollection, eq, liveQueryCollectionOptions } from "@tanstack/db";
import { createBlogLiveOntology } from "./generated/blog.live.js";
import type { OntologyAdapter } from "../OntologyAdapter.js";

declare const adapter: OntologyAdapter;

const blog = createBlogLiveOntology(adapter);
const $post = blog.objectTypes.Post.collection;
const $comment = blog.objectTypes.Comment.collection;

// if we're joining authors to posts, we need to know that link and both object types

// Join by relationship: generic locks source aliases to the current .from() shape.
const postListWithAuthor = createCollection(
    liveQueryCollectionOptions({
        query: blog
            .query()
            .from({ post: $post })
            .related("post", "author")
            .select(({ post, author }) => ({
                postId: post.postId,
                title: post.title,
                authorName: author?.name,
            })),
    })
);

// You can also start from an object type name directly.
const postListWithAuthorFromObjectType = createCollection(
    liveQueryCollectionOptions({
        query: blog
            .query()
            .from("Post")
            .related("post", "author")
            .select(({ post, author }) => ({
                postId: post.postId,
                title: post.title,
                authorName: author?.name,
            })),
    })
);

// basically need to know links when we build query, and we will prob need to
// rebuild query if things change.  so we basically want a dependent query?

// Same, using the object type entry; join alias can be custom.
const postListWithAuthorViaEntry = createCollection(
    liveQueryCollectionOptions({
        query: blog
            .query()
            .from({ post: $post })
            .related("post", "author", "postAuthor")
            .select(({ post, postAuthor }) => ({
                postId: post.postId,
                title: post.title,
                authorName: postAuthor?.name,
            })),
    })
);

// Reverse link is available too: Post -> Comment via "comments".
const postListWithComments = createCollection(
    liveQueryCollectionOptions({
        query: blog
            .query()
            .from({ post: $post })
            .related("post", "comments", "postComment")
            .select(({ post, postComment }) => ({
                postId: post.postId,
                title: post.title,
                commentId: postComment?.commentId,
            })),
    })
);

// Multi-join: Comment -> Post and Comment -> Author; generic ensures alias matches context.
const commentFeed = createCollection(
    liveQueryCollectionOptions({
        query: blog
            .query()
            .from({ comment: $comment })
            .related("comment", "post")
            .related("comment", "author", "commentAuthor")
            .where(({ post }) => eq(post?.status, "published"))
            .select(({ comment, post, commentAuthor }) => ({
                commentId: comment.commentId,
                body: comment.body,
                postTitle: post?.title,
                authorDisplay: concat(commentAuthor?.name, " <", commentAuthor?.email, ">"),
            })),
    })
);

// You can still inspect generated relationship metadata on each collection.
export const postRelationships = blog.objectTypes.Post.links;
export const commentRelationships = blog.objectTypes.Comment.links;
export const authorRelationships = blog.objectTypes.Author.links;
export const postAuthorLink = blog.objectTypes.Post.links.author;

void postListWithAuthor;
void postListWithAuthorFromObjectType;
void postListWithAuthorViaEntry;
void postListWithComments;
void commentFeed;
