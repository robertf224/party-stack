import {
    cloneDefinition,
    omitInvalid,
    withDefinitionIds,
    withoutDefaultIds,
} from "@party-stack/ontology-spec";
import metaOntology from "@party-stack/ontology-spec/meta";
import * as q from "@party-stack/ontology-spec/query";
import { and, inArray, field, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect, Stream } from "effect";
import { makeOntologyBackend } from "./query.js";
import { compileObjectSubset, objectSubset } from "./subset.js";
import { BackendError } from "./index.js";
import type { OntologyBackendService, SubsetWatchEvent } from "./index.js";
import type { OmittedDefinition, OntologyIR } from "@party-stack/ontology-spec";
import type {
    ActionType,
    ObjectType,
    QueryFunctionType,
    TypeDef,
    Ontology as OntologyDescriptor,
} from "@party-stack/ontology-spec/meta";
import type { Scope } from "effect";

function getValueTypes(type: TypeDef): string[] {
    switch (type.kind) {
        case "list":
            return getValueTypes(type.value.elementType);
        case "map":
            return [...getValueTypes(type.value.keyType), ...getValueTypes(type.value.valueType)];
        case "optional":
            return getValueTypes(type.value.type);
        case "encrypted":
            return getValueTypes(type.value.type);
        case "result":
            return [...getValueTypes(type.value.okType), ...getValueTypes(type.value.errType)];
        case "struct":
            return type.value.fields.flatMap((field) => getValueTypes(field.type));
        case "union":
            return type.value.variants.flatMap((variant) => getValueTypes(variant.type));
        case "ref":
            return [type.value.name];
        default:
            return [];
    }
}

function getObjectTypeValueTypes(objectType: ObjectType): string[] {
    return Array.from(new Set(objectType.properties.flatMap((p) => getValueTypes(p.type))));
}

function getActionTypeValueTypes(actionType: ActionType): string[] {
    return [
        ...actionType.parameters.flatMap((parameter) => getValueTypes(parameter.type)),
        ...(actionType.returnType ? getValueTypes(actionType.returnType) : []),
    ];
}

function getQueryFunctionTypeValueTypes(queryFunctionType: QueryFunctionType): string[] {
    return [
        ...queryFunctionType.parameters.flatMap((parameter) => getValueTypes(parameter.type)),
        ...getValueTypes(queryFunctionType.returnType),
    ];
}

export interface PullOptions {
    /** Omitted selects all definitions of this kind; an empty array selects none. */
    objectTypeNames?: string[];
    actionTypeNames?: string[];
    queryFunctionTypeNames?: string[];
    /** App-specific definition edits, applied before invalid definitions are omitted. */
    transform?: (ontology: OntologyIR) => OntologyIR | Promise<OntologyIR>;
    /** Resolve to `{ ontology, omitted }` instead of the IR alone. */
    includeOmitted?: boolean;
}
/** Which definitions to take from the metadata, and app-specific edits to apply to them. */
export type DefinitionSelection = Omit<PullOptions, "includeOmitted">;

export interface PullResult {
    /** A valid Ontology. */
    readonly ontology: OntologyIR;
    /**
     * Definitions (or action parameter defaults) the provider exposes but the IR could not
     * represent, and why. A caller that needs the complete Ontology treats any entry as a failure.
     */
    readonly omitted: readonly OmittedDefinition[];
}

const pullDefinitions = Effect.fn("Metadata.pull")(function* (
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions = {}
) {
    const select = (objectType: string, scan: Parameters<typeof objectSubset>[1]) => ({
        ...objectSubset(objectType, scan),
        select: metaOntology.objectTypes
            .find((type) => type.name === objectType)!
            .properties.map((property) => q.selectField(property.name, q.field("row", property.name))),
    });
    const { objectTypeNames, actionTypeNames, queryFunctionTypeNames } = options;
    const result = yield* backend.query({
        select: [
            q.sub(
                "objectTypes",
                select("ObjectType", { where: objectTypeNames && inArray(field("name"), objectTypeNames) })
            ),
            q.sub(
                "descriptors",
                select("Ontology", { orderBy: [{ field: field("id"), direction: "asc" }], limit: 2 })
            ),
            q.sub(
                "linkTypes",
                select("LinkType", {
                    where:
                        objectTypeNames &&
                        and(
                            inArray(field("source", "objectType"), objectTypeNames),
                            inArray(field("target", "objectType"), objectTypeNames)
                        ),
                })
            ),
            q.sub(
                "actionTypes",
                select("ActionType", { where: actionTypeNames && inArray(field("name"), actionTypeNames) })
            ),
            q.sub(
                "queryFunctionTypes",
                select("QueryFunctionType", {
                    where: queryFunctionTypeNames && inArray(field("name"), queryFunctionTypeNames),
                })
            ),
            // Value types are referenced by name from inside other definitions' types, which a
            // query cannot follow. There are few, so read them all in the same request and keep
            // the ones the selection uses.
            q.sub("valueTypes", select("ValueType", {})),
        ],
    });
    // A projection reads every meta property; one a row does not set is absent, not undefined.
    const rows = <A>(value: unknown) =>
        (value as Record<string, unknown>[]).map(
            (row) => Object.fromEntries(Object.entries(row).filter(([, field]) => field !== undefined)) as A
        );
    const objectTypes = rows<ObjectType>(result.objectTypes);
    const descriptors = rows<OntologyDescriptor>(result.descriptors);
    const linkTypes = rows<OntologyIR["linkTypes"][number]>(result.linkTypes);
    const actionTypes = rows<ActionType>(result.actionTypes);
    const queryFunctionTypes = rows<QueryFunctionType>(result.queryFunctionTypes);
    const valueTypes = new Map(
        rows<OntologyIR["types"][number]>(result.valueTypes).map((type) => [type.name, type])
    );
    const invalid = (message: string) =>
        new BackendError({ operation: "metadata.pull", kind: "InvalidResponse", retryable: false, message });
    if (descriptors.length !== 1 || descriptors[0]?.id !== "ontology")
        return yield* invalid("Metadata must expose exactly one Ontology descriptor with id ontology.");
    const descriptor = descriptors[0];

    for (const [kind, requested, definitions] of [
        ["object types", objectTypeNames, objectTypes],
        ["action types", actionTypeNames, actionTypes],
        ["query function types", queryFunctionTypeNames, queryFunctionTypes],
    ] as const) {
        if (!requested) continue;
        const returned = new Set(definitions.map((definition) => definition.name));
        const missing = [...new Set(requested)].filter((name) => !returned.has(name));
        if (missing.length)
            return yield* invalid(`Missing requested metadata ${kind}: ${missing.join(", ")}.`);
    }

    const valueTypeNames = Array.from(
        new Set([
            ...objectTypes.flatMap(getObjectTypeValueTypes),
            ...actionTypes.flatMap(getActionTypeValueTypes),
            ...queryFunctionTypes.flatMap(getQueryFunctionTypeValueTypes),
            ...(descriptor?.context?.type ? getValueTypes(descriptor.context.type) : []),
        ])
    );

    // Everything when nothing is selected, so a definition round-trips whole; otherwise the
    // value types the selection uses, and the ones those use.
    const selected = objectTypeNames ?? actionTypeNames ?? queryFunctionTypeNames;
    const types: OntologyIR["types"] = selected === undefined ? [...valueTypes.values()] : [];
    if (selected !== undefined) {
        const loaded = new Set<string>();
        let pending = valueTypeNames;
        while (pending.length) {
            const missing = pending.filter((name) => !valueTypes.has(name));
            if (missing.length) return yield* invalid(`Missing metadata value types: ${missing.join(", ")}.`);
            const batch = pending.map((name) => valueTypes.get(name)!);
            for (const type of batch) {
                loaded.add(type.name);
                types.push(type);
            }
            pending = [...new Set(batch.flatMap((type) => getValueTypes(type.type)))].filter(
                (name) => !loaded.has(name)
            );
        }
    }
    // Rows carry every id; one equal to its default is left out, so a definition reads back as
    // it was written. Provider ids are kept.
    const pulled: OntologyIR = withoutDefaultIds({
        types,
        objectTypes,
        linkTypes,
        actionTypes,
        queryFunctionTypes,
        ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
        ...(descriptor?.description === undefined ? {} : { description: descriptor.description }),
        ...(descriptor?.context === undefined ? {} : { context: descriptor.context }),
        ...(descriptor?.policy === undefined ? {} : { policy: descriptor.policy }),
    });
    const definition = options.transform
        ? yield* Effect.tryPromise({
              try: async () => options.transform!(pulled),
              catch: (cause) =>
                  new BackendError({
                      operation: "metadata.pull.transform",
                      kind: "InvalidConfiguration",
                      retryable: false,
                      message: cause instanceof Error ? cause.message : "The ontology transform failed.",
                      cause,
                  }),
          })
        : pulled;
    // One definition the IR cannot represent should not make the whole Ontology unusable.
    const repaired = omitInvalid(definition);
    if (repaired.issues.length)
        return yield* new BackendError({
            operation: "metadata.pull",
            kind: options.transform ? "InvalidConfiguration" : "InvalidResponse",
            retryable: false,
            message: `Pulled ontology is invalid: ${repaired.issues.map((issue) => issue.message).join(" ")}`,
            issues: repaired.issues,
        });
    if (repaired.omitted.length)
        yield* Effect.logWarning("Omitted definitions the Ontology IR cannot represent.").pipe(
            Effect.annotateLogs({
                // With the reason, so an omission can be fixed at its source without a debugger.
                omitted: repaired.omitted.map(
                    (entry) =>
                        `${entry.name}${entry.parameter ? `.${entry.parameter}` : ""}: ${entry.issues
                            .map((issue) => issue.message)
                            .join(" ")}`
                ),
            })
        );
    const pulledResult: PullResult = { ontology: repaired.ontology, omitted: repaired.omitted };
    return pulledResult;
});

/**
 * Pull selected definitions directly from a metadata backend, without a replica or UI collections.
 *
 * Definitions the IR cannot represent are omitted (see `omitInvalid`) and logged as a warning,
 * rather than failing the pull. Pass `includeOmitted: true` to also receive what was omitted.
 */
export function pull(
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions & { readonly includeOmitted: true }
): Effect.Effect<PullResult, BackendError>;
export function pull(
    backend: Pick<OntologyBackendService, "query">,
    options?: PullOptions
): Effect.Effect<OntologyIR, BackendError>;
export function pull(
    backend: Pick<OntologyBackendService, "query">,
    options: PullOptions = {}
): Effect.Effect<OntologyIR | PullResult, BackendError> {
    const result = pullDefinitions(backend, options);
    return options.includeOmitted ? result : Effect.map(result, (pulled) => pulled.ontology);
}

/** Assemble a runtime definition through ordinary metadata queries. Completeness
 * is the adapter's query contract; this does not invent an atomic provider revision.
 */
export const loadDefinition = (backend: Pick<OntologyBackendService, "query">) => pull(backend);

export interface MetadataBackendOptions {
    /** Emits when the definition this backend describes has been replaced. Watches report it as
     * a reset, so a replica of the metadata reloads it. */
    readonly replaced?: Stream.Stream<unknown, BackendError>;
}
/** Serve a definition as meta ontology rows. */
export function makeMetadataBackend(
    ir: OntologyIR,
    options: MetadataBackendOptions = {}
): OntologyBackendService {
    // Meta rows always carry ids; a definition without them is given its defaults.
    ir = withDefinitionIds(cloneDefinition(ir));

    return makeOntologyBackend({
        ir: metaOntology,
        name: "local-metadata",
        sourceId: "local-metadata",
        supportsIdempotency: false,
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(metaOntology, request), (subset) =>
                Effect.suspend(() => {
                    const rows: Record<string, readonly object[]> = {
                        Ontology: [
                            {
                                id: "ontology",
                                displayName: ir.displayName,
                                description: ir.description,
                                context: ir.context,
                                policy: ir.policy,
                            },
                        ],
                        ObjectType: ir.objectTypes,
                        ValueType: ir.types,
                        LinkType: ir.linkTypes,
                        ActionType: ir.actionTypes,
                        QueryFunctionType: ir.queryFunctionTypes,
                    };
                    const type = metaOntology.objectTypes.find((type) => type.name === subset.objectType);
                    if (!type)
                        return Effect.fail(
                            new BackendError({
                                operation: "loadSubset",
                                kind: "InvalidRequest",
                                message: "Unknown metadata object type.",
                                retryable: false,
                            })
                        );
                    return Effect.succeed({
                        rows: evaluateQuery(
                            rows[subset.objectType]!.map((row) => ({
                                key: (row as Record<string, unknown>)[type.primaryKey] as string,
                                value: row as Record<string, unknown>,
                            })),
                            subset.query ?? {}
                        ),
                        complete: true,
                    });
                })
            ),
        ...(options.replaced && {
            watchSubset: () => Effect.succeed(Stream.map(options.replaced!, (): SubsetWatchEvent => "reset")),
        }),
        applyAction: () =>
            Effect.fail(
                new BackendError({
                    operation: "applyAction",
                    kind: "NotImplemented",
                    message: "Metadata is read-only.",
                    retryable: false,
                })
            ),
        queryFunction: () =>
            Effect.fail(
                new BackendError({
                    operation: "queryFunction",
                    kind: "NotImplemented",
                    message: "Local metadata has no query functions.",
                    retryable: false,
                })
            ),
    });
}

export interface OntologyPullConfig<R = never> extends Omit<PullOptions, "queryFunctionTypeNames"> {
    readonly queryFunctionTypeNames?: string[];
    readonly backend: Effect.Effect<OntologyBackendService, BackendError, R | Scope.Scope>;
}
