import { eq, queryOnce, type Collection } from "@tanstack/db";
import {
    OntologyLinkError,
    normalizeLinkRef,
    resolveOntologyLink,
    type ResolvedOntologyLink,
} from "./resolveOntologyLink.js";
import type { OntologyIR } from "../../ir/index.js";
import type {
    OntologyGetLinkOpts,
    OntologyLinkPage,
    OntologyLinkedObject,
    OntologyLinksAdapter,
    OntologyListLinksOpts,
} from "../OntologyBackendAdapter.js";

const LOCAL_FK_PAGE_TOKEN_PREFIX = "local-fk:";

export interface LiveOntologyLinks {
    get: (
        opts: Omit<OntologyGetLinkOpts, "link"> & {
            link: string | OntologyGetLinkOpts["link"];
        }
    ) => Promise<OntologyLinkedObject | undefined>;
    list: (
        opts: Omit<OntologyListLinksOpts, "link"> & {
            link: string | OntologyListLinksOpts["link"];
        }
    ) => Promise<OntologyLinkPage>;
}

function toLinkedObject(
    objectType: string,
    primaryKeyProperty: string,
    properties: Record<string, unknown>,
    select?: string[]
): OntologyLinkedObject | undefined {
    const primaryKey = properties[primaryKeyProperty];
    if (typeof primaryKey !== "string" && typeof primaryKey !== "number") {
        return undefined;
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
        if (key.startsWith("$") || (select && key !== primaryKeyProperty && !select.includes(key))) {
            continue;
        }
        cleaned[key] = value;
    }
    return {
        objectType,
        primaryKey,
        properties: cleaned,
    };
}

async function queryObjects(
    collection: Collection<Record<string, unknown>>,
    primaryKeyProperty: string,
    filter: { property: string; value: string | number },
    opts: { limit?: number; offset?: number } = {}
): Promise<Record<string, unknown>[]> {
    return queryOnce((q) => {
        let query = q
            .from({ object: collection })
            .where(({ object }) =>
                eq(
                    (object as Record<string, unknown>)[filter.property] as never,
                    filter.value as never
                )
            )
            .orderBy(
                ({ object }) => (object as Record<string, unknown>)[primaryKeyProperty],
                "asc"
            );

        if (opts.limit !== undefined) {
            query = query.limit(opts.limit);
        }
        if (opts.offset !== undefined && opts.offset > 0) {
            query = query.offset(opts.offset);
        }

        return query.select(({ object }) => object as Record<string, unknown>);
    });
}

async function queryObject(
    collection: Collection<Record<string, unknown>>,
    primaryKeyProperty: string,
    primaryKey: string | number
): Promise<Record<string, unknown> | undefined> {
    return (
        await queryObjects(
            collection,
            primaryKeyProperty,
            { property: primaryKeyProperty, value: primaryKey },
            { limit: 1 }
        )
    )[0];
}

function parseLocalPageOffset(pageToken: string | undefined, pageSize: number | undefined): number {
    if (pageToken === undefined) {
        return 0;
    }
    if (pageSize === undefined) {
        throw new OntologyLinkError("A local FK page token requires pageSize.");
    }
    if (!pageToken.startsWith(LOCAL_FK_PAGE_TOKEN_PREFIX)) {
        throw new OntologyLinkError("Invalid local FK link page token.");
    }
    const offset = Number(pageToken.slice(LOCAL_FK_PAGE_TOKEN_PREFIX.length));
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new OntologyLinkError("Invalid local FK link page token.");
    }
    return offset;
}

function normalizePageSize(pageSize: number | undefined): number | undefined {
    if (pageSize === undefined) {
        return undefined;
    }
    const normalized = Math.trunc(pageSize);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw new OntologyLinkError("Link pageSize must be a positive integer.");
    }
    return normalized;
}

function requirePrimaryKeyProperty(ir: OntologyIR, objectType: string): string {
    const def = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!def) {
        throw new OntologyLinkError(`Unknown object type "${objectType}".`);
    }
    return def.primaryKey;
}

async function listLocalFkLinks(opts: {
    ir: OntologyIR;
    objects: Record<string, Collection<Record<string, unknown>>>;
    resolved: ResolvedOntologyLink;
    objectType: string;
    primaryKey: string | number;
    pageSize?: number;
    pageToken?: string;
    select?: string[];
}): Promise<OntologyLinkPage | undefined> {
    const { resolved } = opts;
    if (!resolved.foreignKey) {
        return undefined;
    }

    const sourcePrimaryKey = requirePrimaryKeyProperty(opts.ir, opts.objectType);
    const targetPrimaryKey = requirePrimaryKeyProperty(opts.ir, resolved.targetObjectType);
    const sourceCollection = opts.objects[opts.objectType];
    const targetCollection = opts.objects[resolved.targetObjectType];
    if (!sourceCollection || !targetCollection) {
        return undefined;
    }
    const pageSize = normalizePageSize(opts.pageSize);
    const offset = parseLocalPageOffset(opts.pageToken, pageSize);

    if (resolved.foreignKeyOnCurrentObject) {
        if (offset > 0) {
            return { objects: [] };
        }
        const source = await queryObject(sourceCollection, sourcePrimaryKey, opts.primaryKey);
        if (!source) {
            return { objects: [] };
        }
        const foreignKeyValue = source[resolved.foreignKey];
        if (typeof foreignKeyValue !== "string" && typeof foreignKeyValue !== "number") {
            return { objects: [] };
        }
        const target = await queryObject(targetCollection, targetPrimaryKey, foreignKeyValue);
        const linked = target
            ? toLinkedObject(resolved.targetObjectType, targetPrimaryKey, target, opts.select)
            : undefined;
        return { objects: linked ? [linked] : [] };
    }

    const rows = await queryObjects(
        targetCollection,
        targetPrimaryKey,
        { property: resolved.foreignKey, value: opts.primaryKey },
        {
            limit: pageSize === undefined ? undefined : pageSize + 1,
            offset,
        }
    );
    const hasNextPage = pageSize !== undefined && rows.length > pageSize;
    const pageRows = hasNextPage ? rows.slice(0, pageSize) : rows;
    const objects = pageRows
        .map((row) =>
            toLinkedObject(resolved.targetObjectType, targetPrimaryKey, row, opts.select)
        )
        .filter((object): object is OntologyLinkedObject => object !== undefined);

    return {
        objects,
        nextPageToken: hasNextPage
            ? `${LOCAL_FK_PAGE_TOKEN_PREFIX}${offset + pageSize}`
            : undefined,
    };
}

async function getLocalFkLink(opts: {
    ir: OntologyIR;
    objects: Record<string, Collection<Record<string, unknown>>>;
    resolved: ResolvedOntologyLink;
    objectType: string;
    primaryKey: string | number;
    linkedPrimaryKey?: string | number;
    select?: string[];
}): Promise<{ supported: boolean; object?: OntologyLinkedObject }> {
    const { resolved } = opts;
    if (!resolved.foreignKey) {
        return { supported: false };
    }

    const sourcePrimaryKey = requirePrimaryKeyProperty(opts.ir, opts.objectType);
    const targetPrimaryKey = requirePrimaryKeyProperty(opts.ir, resolved.targetObjectType);
    const sourceCollection = opts.objects[opts.objectType];
    const targetCollection = opts.objects[resolved.targetObjectType];
    if (!sourceCollection || !targetCollection) {
        return { supported: false };
    }

    if (resolved.foreignKeyOnCurrentObject) {
        const source = await queryObject(sourceCollection, sourcePrimaryKey, opts.primaryKey);
        const foreignKeyValue = source?.[resolved.foreignKey];
        if (typeof foreignKeyValue !== "string" && typeof foreignKeyValue !== "number") {
            return { supported: true };
        }
        if (
            opts.linkedPrimaryKey !== undefined &&
            foreignKeyValue !== opts.linkedPrimaryKey
        ) {
            return { supported: true };
        }
        const target = await queryObject(targetCollection, targetPrimaryKey, foreignKeyValue);
        return {
            supported: true,
            object: target
                ? toLinkedObject(
                      resolved.targetObjectType,
                      targetPrimaryKey,
                      target,
                      opts.select
                  )
                : undefined,
        };
    }

    if (opts.linkedPrimaryKey === undefined) {
        if (resolved.cardinality === "many") {
            throw new OntologyLinkError(
                `Link "${opts.objectType}.${resolved.sideName}" is to-many; use links.list().`
            );
        }
        const page = await listLocalFkLinks({
            ...opts,
            pageSize: 1,
        });
        return { supported: true, object: page?.objects[0] };
    }

    const target = await queryObject(
        targetCollection,
        targetPrimaryKey,
        opts.linkedPrimaryKey
    );
    if (target?.[resolved.foreignKey] !== opts.primaryKey) {
        return { supported: true };
    }
    return {
        supported: true,
        object: toLinkedObject(
            resolved.targetObjectType,
            targetPrimaryKey,
            target,
            opts.select
        ),
    };
}

export function createLiveOntologyLinks(opts: {
    ir: OntologyIR;
    objects: Record<string, Collection<Record<string, unknown>>>;
    backendLinks?: OntologyLinksAdapter;
}): LiveOntologyLinks {
    const resolve = (objectType: string, link: string | OntologyGetLinkOpts["link"]) =>
        resolveOntologyLink(opts.ir, objectType, normalizeLinkRef(link));

    return {
        get: async ({ objectType, primaryKey, link, linkedPrimaryKey, select }) => {
            const resolved = resolve(objectType, link);

            if (resolved.foreignKey) {
                const local = await getLocalFkLink({
                    ir: opts.ir,
                    objects: opts.objects,
                    resolved,
                    objectType,
                    primaryKey,
                    linkedPrimaryKey,
                    select,
                });
                if (local.supported) {
                    return local.object;
                }
            }

            if (!opts.backendLinks) {
                throw new OntologyLinkError(
                    `Link "${objectType}.${resolved.sideName}" cannot be traversed locally and no backend links adapter is configured.`
                );
            }

            return opts.backendLinks.get({
                objectType,
                primaryKey,
                link: { sideName: resolved.sideName },
                linkedPrimaryKey,
                select,
            });
        },
        list: async ({ objectType, primaryKey, link, pageSize, pageToken, select }) => {
            const resolved = resolve(objectType, link);

            if (resolved.foreignKey) {
                const page = await listLocalFkLinks({
                    ir: opts.ir,
                    objects: opts.objects,
                    resolved,
                    objectType,
                    primaryKey,
                    pageSize,
                    pageToken,
                    select,
                });
                if (page) {
                    return page;
                }
            }

            if (!opts.backendLinks) {
                throw new OntologyLinkError(
                    `Link "${objectType}.${resolved.sideName}" cannot be traversed locally and no backend links adapter is configured.`
                );
            }

            return opts.backendLinks.list({
                objectType,
                primaryKey,
                link: { sideName: resolved.sideName },
                pageSize,
                pageToken,
                select,
            });
        },
    };
}
