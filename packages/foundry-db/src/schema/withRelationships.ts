/* eslint-disable @typescript-eslint/no-explicit-any */
import { Collection, UtilsRecord } from "@tanstack/db";

export interface Relationship<
    Source extends Collection<any, any, any, any, any>,
    Target extends Collection<any, any, any, any, any>,
    C extends "one" | "many",
> {
    readonly cardinality: C;
    readonly target: Target;
    readonly sourceKey: Source extends Collection<infer T, any, any, any, any> ? keyof T : never;
    readonly targetKey: Target extends Collection<infer T, any, any, any, any> ? keyof T : never;
}

export type Relationships<Source extends Collection<any, any, any, any, any>> = Record<
    string,
    Relationship<Source, Collection<any, any, any, any, any>, "one" | "many">
>;

export type CollectionWithRelationships<
    Source extends Collection<any, any, UtilsRecord, any, any>,
    SourceRelationships extends Relationships<Source>,
> =
    Source extends Collection<infer T, infer TKey, infer TUtils, infer TSchema, infer TInsertInput>
        ? Collection<T, TKey, TUtils & { relationships: SourceRelationships }, TSchema, TInsertInput>
        : never;

export type RelationshipsOf<Source extends Collection<any, any, any, any, any>> =
    Source extends Collection<any, any, infer Utils, any, any>
        ? Utils extends { relationships: infer R }
            ? R extends Relationships<Source>
                ? R
                : never
            : never
        : never;

export function withRelationships<
    Utils extends UtilsRecord,
    Source extends Collection<any, any, Utils, any, any>,
    SourceRelationships extends Relationships<Source>,
>(
    source: Source,
    relationships: SourceRelationships
): CollectionWithRelationships<Source, SourceRelationships> {
    const extendedUtils = {
        ...source.utils,
        relationships,
    };

    return new Proxy(source, {
        get(target, prop) {
            if (prop === "utils") {
                return extendedUtils;
            }
            return target[prop as keyof typeof target];
        },
    }) as unknown as CollectionWithRelationships<Source, SourceRelationships>;
}
