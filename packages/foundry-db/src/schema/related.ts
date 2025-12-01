/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Collection, eq } from "@tanstack/db";
import type { Relationship } from "./withRelationships.js";

/**
 * Extracts the collection from a single-key object like `{ $task }` or `{ $project }`.
 */
type CollectionFromAliasObject<T extends Record<string, Collection<any, any, any, any, any>>> = T[keyof T];

/**
 * Extracts the alias string (key name) from a single-key object like `{ $task }`.
 */
type AliasFromAliasObject<T extends Record<string, Collection<any, any, any, any, any>>> = keyof T & string;

/**
 * Gets the target collection type from a relationship.
 */
type TargetCollectionOf<R> = R extends { target: infer T } ? T : never;

/**
 * Extracts the relationships record from a collection's utils.
 */
type RelationshipsFromCollection<C extends Collection<any, any, any, any, any>> =
    C extends Collection<any, any, infer Utils, any, any>
        ? Utils extends { relationships: infer R }
            ? R
            : never
        : never;

/**
 * A collection that has relationships defined via withRelationships.
 */
type CollectionWithRelationshipUtils = Collection<any, any, { relationships: Record<string, any> }, any, any>;

/**
 * A helper utility for constructing join arguments from relationship definitions.
 *
 * @example
 * ```ts
 * const $taskWithRels = withRelationships($task, ({ one }) => ({
 *   project: one({ sourceKey: "projectId", target: $project, targetKey: "id" }),
 * }));
 *
 * // Basic usage - join alias defaults to relationship name
 * new Query()
 *   .from({ $taskWithRels })
 *   .join(...related({ $taskWithRels }, "project"))
 *   .select(({ $taskWithRels, project }) => ({ ... }));
 *
 * // Custom join alias
 * new Query()
 *   .from({ $taskWithRels })
 *   .join(...related({ $taskWithRels }, "project", "p"))
 *   .select(({ $taskWithRels, p }) => ({ ... }));
 *
 * // Using a different collection alias for the source
 * new Query()
 *   .from({ t: $taskWithRels })
 *   .join(...related({ t: $taskWithRels }, "project"))
 *   .select(({ t, project }) => ({ ... }));
 * ```
 */
export function related<
    SourceAliasObj extends Record<string, CollectionWithRelationshipUtils>,
    SourceCollection extends CollectionFromAliasObject<SourceAliasObj>,
    Rels extends RelationshipsFromCollection<SourceCollection>,
    RelName extends keyof Rels & string,
    JoinAlias extends string = RelName,
>(
    sourceAliasObj: SourceAliasObj,
    relationshipName: RelName,
    joinAlias?: JoinAlias
): RelatedResult<Rels, RelName, JoinAlias> {
    // Extract the source alias and collection from the object
    const sourceAlias = Object.keys(sourceAliasObj)[0] as AliasFromAliasObject<SourceAliasObj>;
    const sourceCollection = sourceAliasObj[sourceAlias] as SourceCollection;

    // Get the relationship definition
    const relationships = sourceCollection.utils.relationships as Rels;
    const rel = relationships[relationshipName] as Relationship<any, any, any>;

    if (!rel) {
        throw new Error(
            `Relationship "${relationshipName}" not found on collection. ` +
                `Available relationships: ${Object.keys(relationships as object).join(", ")}`
        );
    }

    const effectiveJoinAlias = (joinAlias ?? relationshipName) as JoinAlias;

    // Build the join collection object with the alias
    const joinCollectionObj = { [effectiveJoinAlias]: rel.target } as Record<
        JoinAlias,
        TargetCollectionOf<Rels[RelName]>
    >;

    // Build the join condition function
    const joinCondition = (ctx: Record<string, any>) => {
        const source = ctx[sourceAlias];
        const target = ctx[effectiveJoinAlias];
        return eq(source[rel.sourceKey], target[rel.targetKey]);
    };

    return [joinCollectionObj, joinCondition] as RelatedResult<Rels, RelName, JoinAlias>;
}

/**
 * The return type of `related()` - a tuple that can be spread into `.join()`.
 *
 * Note: The callback type is intentionally loose because TanStack DB wraps
 * context values in RefLeaf<T> types at runtime. The actual type checking
 * happens when the result is spread into .join().
 */
export type RelatedResult<
    Rels extends Record<string, any>,
    RelName extends keyof Rels & string,
    JoinAlias extends string,
> = [
    // The join collection object: { [JoinAlias]: TargetCollection }
    Record<JoinAlias, TargetCollectionOf<Rels[RelName]>>,
    // The join condition function - typed loosely to accept TanStack's RefLeaf wrappers
    (ctx: any) => ReturnType<typeof eq>,
];
