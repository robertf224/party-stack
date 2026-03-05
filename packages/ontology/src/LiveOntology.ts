/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Collection, createCollection, eq, type UtilsRecord } from "@tanstack/db";
import type { OntologyIR } from "./ir/index.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";

type OntologyObjectRecord = Record<string, unknown>;
type OntologyObjectTypeMap = Record<string, OntologyObjectRecord>;

/** One link side: object row type and relationship name from the opposite side. */
export type OntologyLinkSideDef<TObject = unknown, TName extends string = string> = {
    object: TObject;
    name: TName;
};

/** One link: both sides and target primary key type. */
export type OntologyLinkDef<
    TSource extends OntologyLinkSideDef = OntologyLinkSideDef,
    TTarget extends OntologyLinkSideDef = OntologyLinkSideDef,
    TKey = string | number,
> = {
    source: TSource;
    target: TTarget;
    targetKey: TKey;
};

/** Map of relationship name -> link def. Used to type related() per object type. */
export type OntologyLinksForObjectType = Record<string, OntologyLinkDef>;

/** Full link map: object type name -> its relationship names -> link def. */
export type OntologyLinkMap = Partial<Record<string, OntologyLinksForObjectType>>;

/** Tuple spreadable into .join(); adds TTarget under TJoinAlias to the row. */
export type OntologyRelatedResult<TJoinAlias extends string, TTarget extends OntologyObjectRecord> = [
    Record<TJoinAlias, Collection<TTarget, string | number, any, any, any>>,
    (ctx: Record<string, unknown>) => ReturnType<typeof eq>,
];

/** Extracts row type from a Collection (matches query builder's schema shape). */
export type InferCollectionRowType<T> = T extends Collection<infer TOutput, any, any, any, any> ? TOutput : never;

/** Schema shape from a source object (e.g. .from({ post: $post }) → { post: Post }). */
export type SchemaFromSource<TSource extends Record<string, unknown>> = {
    [K in keyof TSource]: InferCollectionRowType<TSource[K]>;
};

/** Aliases in TContext (schema: alias → row type) whose value extends TObject. */
export type AliasesMatchingCollection<
    TContext extends Record<string, unknown>,
    TObject extends OntologyObjectRecord,
> = Extract<
    keyof TContext & string,
    { [K in keyof TContext]: TContext[K] extends TObject ? K : never }[keyof TContext]
>;

type LinkTargetObject<TLink> = TLink extends { target: { object: infer TObject } }
    ? TObject extends OntologyObjectRecord
        ? TObject
        : never
    : never;

/** Typed related: overloads for loose (string) and strict (TContext) sourceAlias. */
export interface TypedRelated<
    TLinks extends OntologyLinksForObjectType,
    TObject extends OntologyObjectRecord = OntologyObjectRecord,
> {
    <K extends keyof TLinks & string, A extends string = K>(
        sourceAlias: string,
        relationshipName: K,
        joinAlias?: A
    ): OntologyRelatedResult<A, LinkTargetObject<TLinks[K]>>;
    <TContext extends Record<string, unknown>, K extends keyof TLinks & string, A extends string = K>(
        sourceAlias: AliasesMatchingCollection<TContext, TObject>,
        relationshipName: K,
        joinAlias?: A
    ): OntologyRelatedResult<A, LinkTargetObject<TLinks[K]>>;
}

/** Utils type for a collection with typed related from TLinks. */
export type LiveOntologyCollectionUtilsFor<
    TLinks extends OntologyLinksForObjectType,
    TObject extends OntologyObjectRecord = OntologyObjectRecord,
> = UtilsRecord & {
    related: TypedRelated<TLinks, TObject>;
};

/** Collection type with typed utils so $post.utils.related() gets autocomplete and result types. */
export type LiveOntologyObjectCollection<
    TObject extends OntologyObjectRecord,
    TLinks extends OntologyLinksForObjectType = OntologyLinksForObjectType,
> = Collection<TObject, string | number, LiveOntologyCollectionUtilsFor<TLinks, TObject>, any, any>;

/** Link metadata (runtime only; for typed link names use TLinks). */
export type LiveOntologyLinkMeta = Record<
    string,
    {
        source: { objectType: string; name: string };
        target: { objectType: string; name: string };
        foreignKey: string;
        cardinality: "one" | "many";
    }
>;

export interface LiveOntologyObjectTypeEntry<
    TObject extends OntologyObjectRecord,
    TLinks extends OntologyLinksForObjectType = OntologyLinksForObjectType,
> {
    collection: LiveOntologyObjectCollection<TObject, TLinks>;
    links: LiveOntologyLinkMeta;
    related: TypedRelated<TLinks, TObject>;
}

/** Resolves link defs for one object type; defaults to empty so keyof is never when no links. */
type LinksForObject<OM extends OntologyLinkMap, O extends string> = O extends keyof OM
    ? OM[O] extends OntologyLinksForObjectType
        ? OM[O]
        : Record<string, never>
    : Record<string, never>;

/** When TLinkMap is provided, entries use typed related(); otherwise untyped. */
export interface LiveOntology<
    TObjectTypes extends OntologyObjectTypeMap = OntologyObjectTypeMap,
    TLinkMap extends OntologyLinkMap = OntologyLinkMap,
> {
    objectTypes: {
        [ObjectTypeName in keyof TObjectTypes & string]: LiveOntologyObjectTypeEntry<
            TObjectTypes[ObjectTypeName],
            LinksForObject<TLinkMap, ObjectTypeName>
        >;
    };
}

export interface LiveOntologyOpts {
    ir: OntologyIR;
    adapter: OntologyAdapter;
}

type AnyCollection = Collection<any, any, any, any, any>;

function withCollectionUtils<TCollection extends AnyCollection, TExtraUtils extends UtilsRecord>(
    collection: TCollection,
    extraUtils: TExtraUtils
): Collection<
    any,
    any,
    TCollection extends Collection<any, any, infer TUtils, any, any> ? TUtils & TExtraUtils : TExtraUtils,
    any,
    any
> {
    const mergedUtils = { ...(collection.utils as object), ...extraUtils };
    return new Proxy(collection, {
        get(target, prop) {
            if (prop === "utils") {
                return mergedUtils;
            }
            return target[prop as keyof typeof target];
        },
    }) as Collection<any, any, any, any, any>;
}

export function createLiveOntology<
    TObjectTypes extends OntologyObjectTypeMap = OntologyObjectTypeMap,
    TLinkMap extends OntologyLinkMap = OntologyLinkMap,
>(opts: LiveOntologyOpts): LiveOntology<TObjectTypes, TLinkMap> {
    const objectTypesByName = new Map(opts.ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    const baseCollections: Record<string, AnyCollection> = Object.fromEntries(
        opts.ir.objectTypes.map((objectType) => [
            objectType.name,
            createCollection({
                sync: opts.adapter.getSyncConfig(objectType.name),
                getKey: (object) => {
                    const key = (object as Record<string, string | number | undefined>)[
                        objectType.primaryKey
                    ];
                    if (key === undefined) {
                        throw new Error(
                            `Primary key "${objectType.primaryKey}" is missing on an object in "${objectType.name}".`
                        );
                    }
                    return key;
                },
            }),
        ])
    );

    const rawLinksBySource: Record<
        string,
        Record<
            string,
            {
                targetObjectType: string;
                sourceName: string;
                targetName: string;
                foreignKey: string;
                targetPrimaryKey: string;
                cardinality: "one" | "many";
            }
        >
    > = {};
    for (const linkType of opts.ir.linkTypes) {
        const targetType = objectTypesByName.get(linkType.target.objectType);
        if (!targetType) {
            continue;
        }

        rawLinksBySource[linkType.source.objectType] ??= {};
        rawLinksBySource[linkType.source.objectType]![linkType.target.name] = {
            targetObjectType: linkType.target.objectType,
            sourceName: linkType.source.name,
            targetName: linkType.target.name,
            foreignKey: linkType.foreignKey,
            targetPrimaryKey: targetType.primaryKey,
            cardinality: linkType.cardinality,
        };
    }

    const objectTypes: Record<string, LiveOntologyObjectTypeEntry<OntologyObjectRecord>> = {};
    for (const objectType of opts.ir.objectTypes) {
        const sourceLinks = rawLinksBySource[objectType.name] ?? {};

        const getLink = (relationshipName: string) => {
            const link = sourceLinks[relationshipName];
            if (!link) {
                throw new Error(
                    `Unknown relationship "${relationshipName}" on object type "${objectType.name}". ` +
                        `Available relationships: ${Object.keys(sourceLinks).join(", ")}`
                );
            }
            return link;
        };

        const related = (sourceAlias: string, relationshipName: string, joinAlias?: string) => {
            const link = getLink(relationshipName);
            const effectiveJoinAlias = joinAlias ?? relationshipName;
            const target =
                objectTypes[link.targetObjectType]?.collection ?? baseCollections[link.targetObjectType];
            if (!target) {
                throw new Error(
                    `Unknown target object type "${link.targetObjectType}" for relationship "${relationshipName}".`
                );
            }

            const joinCollection = { [effectiveJoinAlias]: target };
            const joinCondition = (ctx: Record<string, unknown>) => {
                const sourceRow = ctx[sourceAlias] as Record<string, unknown> | undefined;
                const targetRow = ctx[effectiveJoinAlias] as Record<string, unknown> | undefined;
                if (!sourceRow || typeof sourceRow !== "object") {
                    const available = Object.keys(ctx).join(", ") || "(none)";
                    throw new Error(
                        `related("${sourceAlias}", "${relationshipName}"): context has no alias "${sourceAlias}". ` +
                            `Available aliases in this query: ${available}. ` +
                            `Use the alias of this collection (e.g. .from({ ${sourceAlias}: $${objectType.name} })).`
                    );
                }
                const targetPk =
                    targetRow && typeof targetRow === "object" ? targetRow[link.targetPrimaryKey] : undefined;
                return eq(sourceRow[link.foreignKey], targetPk);
            };
            return [joinCollection, joinCondition];
        };

        const links = Object.fromEntries(
            Object.entries(sourceLinks).map(([name, link]) => [
                name,
                {
                    source: { objectType: objectType.name, name: link.sourceName },
                    target: { objectType: link.targetObjectType, name: link.targetName },
                    foreignKey: link.foreignKey,
                    cardinality: link.cardinality,
                },
            ])
        );

        const collection = withCollectionUtils(baseCollections[objectType.name]!, {
            related,
        }) as LiveOntologyObjectCollection<OntologyObjectRecord, OntologyLinksForObjectType>;

        objectTypes[objectType.name] = {
            collection,
            links,
            related,
        } as unknown as LiveOntologyObjectTypeEntry<OntologyObjectRecord, OntologyLinksForObjectType>;
    }

    return { objectTypes } as unknown as LiveOntology<TObjectTypes, TLinkMap>;
}
