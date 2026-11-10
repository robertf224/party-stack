import { collectionOptions, eq, Query } from "@tanstack/db";
import type { OntologyDefinition, OntologyObject } from "@party-stack/ontology-spec";
import type {
    CollectionConfig,
    CollectionOptions,
    ContextFromSource,
    QueryBuilder,
    RefsForContext,
    Source,
} from "@tanstack/db";

export const ontologyCollectionDependency = "@party-stack/ontology/collectionOptions";
export type OntologyCollectionResolver = (
    id: string,
    objectType: string,
    localOnly: boolean
) => CollectionConfig<OntologyObject, string | number>;

export type OntologyLinkDefinitions<Definition extends OntologyDefinition> = Partial<{
    readonly [Name in keyof Definition["objectTypes"]]: Readonly<
        Record<
            string,
            {
                readonly objectType: Extract<keyof Definition["objectTypes"], string>;
                readonly source: readonly string[];
                readonly target: readonly string[];
            }
        >
    >;
}>;
type Descriptor<
    Definition extends OntologyDefinition,
    Name extends keyof Definition["objectTypes"],
> = CollectionOptions<Definition["objectTypes"][Name], string | number>;
type RowRef<S extends Source[string]> = RefsForContext<ContextFromSource<{ row: S }>>["row"];
type LinkQuery<Definition extends OntologyDefinition, Link> = Link extends {
    objectType: infer Target extends keyof Definition["objectTypes"];
}
    ? QueryBuilder<ContextFromSource<{ row: Descriptor<Definition, Target> }>>
    : never;

export type OntologyCollectionDescriptors<
    Definition extends OntologyDefinition,
    Links extends OntologyLinkDefinitions<Definition> = Record<never, never>,
> = {
    readonly [Name in keyof Definition["objectTypes"]]: CollectionOptions<
        Definition["objectTypes"][Name],
        string | number
    > & {
        readonly primaryKey: Extract<keyof Definition["objectTypes"][Name], string>;
        readonly links: Name extends keyof Links
            ? {
                  readonly [Link in keyof Links[Name]]: (
                      row: RowRef<Descriptor<Definition, Name>>
                  ) => LinkQuery<Definition, Links[Name][Link]>;
              }
            : Record<never, never>;
    };
};

/** Reusable module-level descriptors. Each ontology's DbClient supplies the replica
 * and owns the collection instances; descriptors contain neither account data nor IO.
 */
export function ontologyCollections<
    Definition extends OntologyDefinition,
    const Links extends OntologyLinkDefinitions<Definition> = Record<never, never>,
>(
    primaryKeys: {
        readonly [Name in keyof Definition["objectTypes"]]: Extract<
            keyof Definition["objectTypes"][Name],
            string
        >;
    },
    linkDefinitions?: Links
) {
    const descriptors = (localOnly: boolean) => {
        const entries = new Map<
            string,
            CollectionOptions<OntologyObject, string | number> & { readonly primaryKey: string }
        >();
        const result: OntologyCollectionDescriptors<Definition, Links> = new Proxy(Object.create(null), {
            get: (_target, name) => {
                if (typeof name !== "string" || name === "then") return undefined;
                let descriptor = entries.get(name);
                if (!descriptor) {
                    const id = `party-stack:${localOnly ? "cached" : "objects"}:${name}`;
                    const primaryKey = primaryKeys[name];
                    if (!primaryKey) throw new Error(`Missing primary key for ontology collection: ${name}`);
                    const native = collectionOptions(id, (client) =>
                        client.requireDependency<OntologyCollectionResolver>(ontologyCollectionDependency)(
                            id,
                            name,
                            localOnly
                        )
                    );
                    const links = Object.fromEntries(
                        Object.entries(linkDefinitions?.[name] ?? {}).map(([name, link]) => [
                            name,
                            (parent: Record<string, unknown>) =>
                                new Query().from({ row: result[link.objectType] }).where(({ row }) =>
                                    eq(
                                        link.target.reduce(
                                            (value, key) => (value as Record<string, unknown>)[key],
                                            row as unknown
                                        ),
                                        link.source.reduce(
                                            (value, key) => (value as Record<string, unknown>)[key],
                                            parent as unknown
                                        )
                                    )
                                ),
                        ])
                    );
                    // Native descriptors are frozen and carry non-enumerable branding
                    // and factories. Preserve those descriptors on a fresh object.
                    descriptor = Object.freeze(
                        Object.defineProperties(
                            { ...native, primaryKey, links: Object.freeze(links) },
                            Object.getOwnPropertyDescriptors(native)
                        )
                    );
                    entries.set(name, descriptor);
                }
                return descriptor;
            },
        });
        return result;
    };
    return { objects: descriptors(false), cachedObjects: descriptors(true) };
}
