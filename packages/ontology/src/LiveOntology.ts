/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
    Collection,
    Query,
    createCollection,
    eq,
    type Context,
    type InitialQueryBuilder,
    type MergeContextWithJoinType,
    type QueryBuilder,
    type Source,
    type UtilsRecord,
} from "@tanstack/db";
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
    query(): LiveOntologyInitialQueryBuilder<TObjectTypes, TLinkMap>;
    query(builder: InitialQueryBuilder): LiveOntologyInitialQueryBuilder<TObjectTypes, TLinkMap>;
    query<TContext extends Context>(
        builder: QueryBuilder<TContext>
    ): LiveOntologyQueryBuilder<TContext, TObjectTypes, TLinkMap>;
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
type AnyQueryBuilder = InitialQueryBuilder | QueryBuilder<any>;

type ContextSchema<TContext extends Context> = TContext["schema"];
type ObjectTypeNameForRow<
    TObjectTypes extends OntologyObjectTypeMap,
    TRow,
> = {
    [ObjectTypeName in keyof TObjectTypes & string]: TRow extends TObjectTypes[ObjectTypeName]
        ? ObjectTypeName
        : never;
}[keyof TObjectTypes & string];
type RelatedLinksForAlias<
    TContext extends Context,
    TObjectTypes extends OntologyObjectTypeMap,
    TLinkMap extends OntologyLinkMap,
    TSourceAlias extends keyof ContextSchema<TContext> & string,
> = LinksForObject<TLinkMap, ObjectTypeNameForRow<TObjectTypes, ContextSchema<TContext>[TSourceAlias]>>;
type RelatedTargetRow<TLink extends OntologyLinkDef> = TLink["target"]["object"] extends OntologyObjectRecord
    ? TLink["target"]["object"]
    : never;
type RelatedJoinSource<TJoinAlias extends string, TTarget extends OntologyObjectRecord> = Record<
    TJoinAlias,
    Collection<TTarget, string | number, any, any, any>
>;
type RelatedContext<
    TContext extends Context,
    TJoinAlias extends string,
    TLink extends OntologyLinkDef,
> = MergeContextWithJoinType<TContext, SchemaFromSource<RelatedJoinSource<TJoinAlias, RelatedTargetRow<TLink>>>, "left">;
type FromContextForObjectType<
    TObjectTypes extends OntologyObjectTypeMap,
    TObjectTypeName extends keyof TObjectTypes & string,
    TAlias extends string,
> = {
    baseSchema: Record<TAlias, TObjectTypes[TObjectTypeName]>;
    schema: Record<TAlias, TObjectTypes[TObjectTypeName]>;
    fromSourceName: TAlias;
    hasJoins: false;
};

export type LiveOntologyInitialQueryBuilder<
    TObjectTypes extends OntologyObjectTypeMap = OntologyObjectTypeMap,
    TLinkMap extends OntologyLinkMap = OntologyLinkMap,
> = Omit<InitialQueryBuilder, "from"> & {
    from<TSource extends Source>(source: TSource): LiveOntologyQueryBuilder<
        {
            baseSchema: SchemaFromSource<TSource>;
            schema: SchemaFromSource<TSource>;
            fromSourceName: keyof TSource & string;
            hasJoins: false;
        },
        TObjectTypes,
        TLinkMap
    >;
    from<
        TObjectTypeName extends keyof TObjectTypes & string,
        TAlias extends string = Uncapitalize<TObjectTypeName>,
    >(
        objectTypeName: TObjectTypeName,
        alias?: TAlias
    ): LiveOntologyQueryBuilder<FromContextForObjectType<TObjectTypes, TObjectTypeName, TAlias>, TObjectTypes, TLinkMap>;
};

export type LiveOntologyQueryBuilder<
    TContext extends Context,
    TObjectTypes extends OntologyObjectTypeMap = OntologyObjectTypeMap,
    TLinkMap extends OntologyLinkMap = OntologyLinkMap,
> = QueryBuilder<TContext> & {
    related<
        TSourceAlias extends keyof ContextSchema<TContext> & string,
        TRelationshipName extends keyof RelatedLinksForAlias<TContext, TObjectTypes, TLinkMap, TSourceAlias> & string,
        TJoinAlias extends string = TRelationshipName,
        TLink extends OntologyLinkDef = RelatedLinksForAlias<
            TContext,
            TObjectTypes,
            TLinkMap,
            TSourceAlias
        >[TRelationshipName] extends OntologyLinkDef
            ? RelatedLinksForAlias<TContext, TObjectTypes, TLinkMap, TSourceAlias>[TRelationshipName]
            : never,
    >(
        sourceAlias: TSourceAlias,
        relationshipName: TRelationshipName,
        joinAlias?: TJoinAlias
    ): LiveOntologyQueryBuilder<RelatedContext<TContext, TJoinAlias, TLink>, TObjectTypes, TLinkMap>;
};

type WrappedQueryReturn<TBuilder extends AnyQueryBuilder, TObjectTypes extends OntologyObjectTypeMap, TLinkMap extends OntologyLinkMap> =
    TBuilder extends InitialQueryBuilder
    ? LiveOntologyInitialQueryBuilder<TObjectTypes, TLinkMap>
    : TBuilder extends QueryBuilder<infer TContext>
      ? LiveOntologyQueryBuilder<TContext, TObjectTypes, TLinkMap>
      : never;

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

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isQueryBuilderLike(value: unknown): value is AnyQueryBuilder {
    return isObject(value) && typeof value.join === "function" && typeof value.where === "function";
}

function wrapLiveOntologyQueryBuilder<
    TObjectTypes extends OntologyObjectTypeMap,
    TLinkMap extends OntologyLinkMap,
    TBuilder extends AnyQueryBuilder,
>(
    ontology: LiveOntology<TObjectTypes, TLinkMap>,
    builder: TBuilder,
    collectionToObjectTypeName: Map<AnyCollection, string>,
    aliasToObjectTypeName: Record<string, string> = {}
): WrappedQueryReturn<TBuilder, TObjectTypes, TLinkMap> {
    const captureAliasesFromSource = (source: unknown, currentAliases: Record<string, string>) => {
        if (!isObject(source)) {
            return currentAliases;
        }
        const nextAliases = { ...currentAliases };
        for (const [alias, maybeCollection] of Object.entries(source)) {
            if (isObject(maybeCollection)) {
                const objectTypeName = collectionToObjectTypeName.get(maybeCollection as unknown as AnyCollection);
                if (objectTypeName) {
                    nextAliases[alias] = objectTypeName;
                }
            }
        }
        return nextAliases;
    };

    const wrapResult = (result: unknown, aliases: Record<string, string>) => {
        if (!isQueryBuilderLike(result)) {
            return result;
        }
        return wrapLiveOntologyQueryBuilder(ontology, result, collectionToObjectTypeName, aliases);
    };

    const proxy = new Proxy(builder as object, {
        get(target, prop, receiver) {
            if (prop === "related") {
                return (sourceAlias: string, relationshipName: string, joinAlias?: string) => {
                    const sourceObjectTypeName = aliasToObjectTypeName[sourceAlias];
                    if (!sourceObjectTypeName) {
                        const available = Object.keys(aliasToObjectTypeName).join(", ") || "(none)";
                        throw new Error(
                            `related("${sourceAlias}", "${relationshipName}"): unknown source alias "${sourceAlias}". ` +
                                `Available aliases: ${available}.`
                        );
                    }

                    const sourceEntry = ontology.objectTypes[sourceObjectTypeName];
                    if (!sourceEntry) {
                        throw new Error(
                            `related("${sourceAlias}", "${relationshipName}"): unknown object type "${sourceObjectTypeName}".`
                        );
                    }

                    const [joinCollection, joinCondition] = sourceEntry.related(
                        sourceAlias,
                        relationshipName,
                        joinAlias
                    );
                    const effectiveJoinAlias = joinAlias ?? relationshipName;
                    const link = sourceEntry.links[relationshipName];
                    if (!link) {
                        const availableRelationships = Object.keys(sourceEntry.links).join(", ") || "(none)";
                        throw new Error(
                            `related("${sourceAlias}", "${relationshipName}"): unknown relationship. ` +
                                `Available relationships on "${sourceObjectTypeName}": ${availableRelationships}.`
                        );
                    }

                    const joined = (target as QueryBuilder<any>).join(joinCollection, joinCondition);
                    return wrapLiveOntologyQueryBuilder(ontology, joined, collectionToObjectTypeName, {
                        ...aliasToObjectTypeName,
                        [effectiveJoinAlias]: link.target.objectType,
                    });
                };
            }

            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") {
                if (prop === "fn" && isObject(value)) {
                    return new Proxy(value, {
                        get(fnTarget, fnProp, fnReceiver) {
                            const fnValue = Reflect.get(fnTarget, fnProp, fnReceiver);
                            if (typeof fnValue !== "function") {
                                return fnValue;
                            }
                            return (...args: unknown[]) => wrapResult(fnValue.apply(fnTarget, args), aliasToObjectTypeName);
                        },
                    });
                }
                return value;
            }

            return (...args: unknown[]) => {
                if (prop === "from" && typeof args[0] === "string") {
                    const objectTypeName = args[0];
                    const aliasArg = args[1];
                    const sourceEntry = ontology.objectTypes[objectTypeName];
                    if (!sourceEntry) {
                        const available = Object.keys(ontology.objectTypes).join(", ") || "(none)";
                        throw new Error(
                            `from("${objectTypeName}"): unknown object type. Available object types: ${available}.`
                        );
                    }
                    const inferredAlias =
                        typeof aliasArg === "string" && aliasArg.length > 0
                            ? aliasArg
                            : objectTypeName.charAt(0).toLowerCase() + objectTypeName.slice(1);
                    const source = { [inferredAlias]: sourceEntry.collection };
                    const result = value.apply(target, [source]);
                    return wrapResult(result, {
                        ...aliasToObjectTypeName,
                        [inferredAlias]: objectTypeName,
                    });
                }

                const result = value.apply(target, args);
                const shouldCaptureSource =
                    prop === "from" ||
                    prop === "join" ||
                    prop === "leftJoin" ||
                    prop === "rightJoin" ||
                    prop === "innerJoin" ||
                    prop === "fullJoin";
                const nextAliases = shouldCaptureSource
                    ? captureAliasesFromSource(args[0], aliasToObjectTypeName)
                    : aliasToObjectTypeName;
                return wrapResult(result, nextAliases);
            };
        },
    });

    return proxy as WrappedQueryReturn<TBuilder, TObjectTypes, TLinkMap>;
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
                sourceField: string;
                targetField: string;
                cardinality: "one" | "many";
            }
        >
    > = {};
    for (const linkType of opts.ir.linkTypes) {
        const sourceType = objectTypesByName.get(linkType.source.objectType);
        const targetType = objectTypesByName.get(linkType.target.objectType);
        if (!sourceType || !targetType) {
            continue;
        }

        rawLinksBySource[linkType.source.objectType] ??= {};
        rawLinksBySource[linkType.source.objectType]![linkType.target.name] = {
            targetObjectType: linkType.target.objectType,
            sourceName: linkType.source.name,
            targetName: linkType.target.name,
            sourceField: linkType.foreignKey,
            targetField: targetType.primaryKey,
            cardinality: linkType.cardinality,
        };

        // Also materialize reverse relationship on the target object type.
        rawLinksBySource[linkType.target.objectType] ??= {};
        rawLinksBySource[linkType.target.objectType]![linkType.source.name] = {
            targetObjectType: linkType.source.objectType,
            sourceName: linkType.target.name,
            targetName: linkType.source.name,
            sourceField: targetType.primaryKey,
            targetField: linkType.foreignKey,
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
                    targetRow && typeof targetRow === "object" ? targetRow[link.targetField] : undefined;
                return eq(sourceRow[link.sourceField], targetPk);
            };
            return [joinCollection, joinCondition];
        };

        const links = Object.fromEntries(
            Object.entries(sourceLinks).map(([name, link]) => [
                name,
                {
                    source: { objectType: objectType.name, name: link.sourceName },
                    target: { objectType: link.targetObjectType, name: link.targetName },
                    foreignKey: link.sourceField,
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

    const ontology = { objectTypes } as unknown as LiveOntology<TObjectTypes, TLinkMap>;
    const collectionToObjectTypeName = new Map<AnyCollection, string>(
        Object.entries(objectTypes).map(([name, entry]) => [entry.collection as AnyCollection, name])
    );
    ontology.query = ((builder?: InitialQueryBuilder | QueryBuilder<any>) =>
        wrapLiveOntologyQueryBuilder(
            ontology,
            builder ?? new Query(),
            collectionToObjectTypeName
        )) as LiveOntology<TObjectTypes, TLinkMap>["query"];
    return ontology;
}
