/**
 * Example live queries using the blog ontology.
 *
 * related(sourceAlias, relationshipName, joinAlias?): sourceAlias is the alias of this
 * collection in the query (e.g. .from({ post: $post }) → "post"); at runtime the context
 * is checked and available aliases are listed if wrong. relationshipName is autocompleted
 * from the opposite side of the link (for Post -> Author, the name is "author").
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
export const postListWithAuthor = createCollection(
    liveQueryCollectionOptions({
        query: (q) =>
            q
                .from({ post: $post })
                .join(...$post.utils.related("post", "author"))
                .select(({ post, author }) => ({
                    postId: post.postId,
                    title: post.title,
                    authorName: author?.name,
                })),
    })
);

// Same, using the object type entry; join alias can be custom.
export const postListWithAuthorViaEntry = createCollection(
    liveQueryCollectionOptions({
        query: (q) =>
            q
                .from({ post: $post })
                .join(...blog.objectTypes.Post.related("post", "author", "postAuthor"))
                .select(({ post, postAuthor }) => ({
                    postId: post.postId,
                    title: post.title,
                    authorName: postAuthor?.name,
                })),
    })
);

// Multi-join: Comment -> Post and Comment -> Author; generic ensures alias matches context.
export const commentFeed = createCollection(
    liveQueryCollectionOptions({
        query: (q) =>
            q
                .from({ comment: $comment })
                .join(...$comment.utils.related("comment", "post"))
                .join(...$comment.utils.related("comment", "author", "commentAuthor"))
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
