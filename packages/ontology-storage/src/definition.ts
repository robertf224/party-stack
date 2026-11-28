import { linkTypeId, withoutDefaultIds } from "@party-stack/ontology-spec";
import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { Effect, Schema, Stream } from "effect";
import { digestBytes } from "./blobs/bytes.js";
import { encodeValue } from "./storage/values.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { FieldDef, QueryDocument, TypeDef } from "@party-stack/ontology-spec";

const decodeStrict = Schema.decodeUnknownSync(OntologyIRSchema, { onExcessProperty: "error" });
const byKey =
    <A>(key: (value: A) => string) =>
    (left: A, right: A) => {
        const a = key(left);
        const b = key(right);
        return a < b ? -1 : a > b ? 1 : 0;
    };
/** An optional field of a definition node set to `undefined` is the same as one left out. Only
 * definition nodes: inside expressions and literal values, `undefined` keeps its meaning. */
const defined = <A extends object>(node: A): A =>
    Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined)) as A;
/**
 * A struct's fields are named, so their order carries no meaning, and a provider may list them in
 * a different order from one request to the next. Compare and hash them in name order. Only type
 * definitions are reordered; literal values and expressions keep their order.
 */
function canonicalType(type: TypeDef): TypeDef {
    switch (type.kind) {
        case "struct":
            return {
                ...type,
                value: {
                    ...type.value,
                    fields: type.value.fields.map(canonicalField).sort(byKey((field) => field.name)),
                },
            };
        case "union":
            return {
                ...type,
                value: {
                    ...type.value,
                    variants: type.value.variants.map((variant) => ({
                        ...variant,
                        type: canonicalType(variant.type),
                    })),
                },
            };
        case "list":
            return { ...type, value: { ...type.value, elementType: canonicalType(type.value.elementType) } };
        case "map":
            return {
                ...type,
                value: {
                    ...type.value,
                    keyType: canonicalType(type.value.keyType),
                    valueType: canonicalType(type.value.valueType),
                },
            };
        case "optional":
        case "encrypted":
            return { ...type, value: { ...type.value, type: canonicalType(type.value.type) } } as TypeDef;
        case "result":
            return {
                ...type,
                value: {
                    ...type.value,
                    okType: canonicalType(type.value.okType),
                    errType: canonicalType(type.value.errType),
                },
            };
        default:
            return type;
    }
}
const canonicalField = <A extends { readonly type: TypeDef }>(field: A): A => ({
    ...defined(field),
    type: canonicalType(field.type),
});
const fields = <A extends { readonly parameters: readonly FieldDef[]; readonly returnType?: TypeDef }>(
    node: A
): A => ({
    ...defined(node),
    parameters: node.parameters.map(canonicalField),
    ...(node.returnType === undefined ? {} : { returnType: canonicalType(node.returnType) }),
});
/** The order of a definition's named collections and of its struct fields carries no meaning, and a
 * definition read back from meta ontology rows or pulled again from a provider need not keep it (nor
 * fields set to `undefined`): compare and hash them in name order. */
const decodeDefinition = (ir: OntologyIR): OntologyIR => {
    // A definition read back from meta rows carries every id; one equal to its default is the
    // same as none.
    const definition = withoutDefaultIds(decodeStrict(ir));
    return {
        ...defined(definition),
        ...(definition.context?.type === undefined
            ? {}
            : { context: { ...definition.context, type: canonicalType(definition.context.type) } }),
        types: [...definition.types]
            .map((type) => ({ ...defined(type), type: canonicalType(type.type) }))
            .sort(byKey((type) => type.name)),
        objectTypes: [...definition.objectTypes]
            .map((type) => ({ ...defined(type), properties: type.properties.map(canonicalField) }))
            .sort(byKey((type) => type.name)),
        linkTypes: [...definition.linkTypes]
            .map((link) => ({ ...defined(link), source: defined(link.source), target: defined(link.target) }))
            .sort(byKey(linkTypeId)),
        actionTypes: [...definition.actionTypes].map(fields).sort(byKey((type) => type.name)),
        queryFunctionTypes: [...definition.queryFunctionTypes].map(fields).sort(byKey((type) => type.name)),
    };
};

// Definitions are immutable once supplied to storage, replicas or servers. Opening
// one route computes the same full-definition signatures several times (server
// Describe, replica engine, bootstrap checks); a large provider IR makes each
// walk expensive on mobile JavaScript engines. Cache by definition identity.
const signatures = new WeakMap<object, string>();
const contractSignatures = new WeakMap<object, string>();
const memoize = (cache: WeakMap<object, string>, ir: OntologyIR, compute: () => string) => {
    let signature = cache.get(ir);
    if (signature === undefined) {
        signature = compute();
        cache.set(ir, signature);
    }
    return signature;
};

/** Stable across property ordering introduced by schema/wire decoding, and across the order of
 * the definition's named collections (types, object, link, action and query function types).
 * The portable codec also preserves literal undefined, Temporal and collection values.
 * Results are cached per definition object; do not mutate a definition after use.
 */
export function ontologyDefinitionSignature(ir: OntologyIR): string {
    return memoize(signatures, ir, () => encodeValue(decodeDefinition(ir)));
}

// Provider ids are not part of the contract: a definition generated without them is compatible
// with the provider's. A changed id still resets cached rows (see the replica's reset plan).
const presentation = new Set([
    "id",
    "displayName",
    "pluralDisplayName",
    "description",
    "deprecated",
    "icon",
    "color",
    "title",
]);
// Only call this for definition nodes. Expressions, literal data and provider
// metadata may legitimately have these same keys and must retain their meaning.
const contractNode = (node: object) =>
    Object.fromEntries(Object.entries(node).filter(([key]) => !presentation.has(key)));
const contractField = (field: FieldDef): unknown => ({
    ...contractNode(field),
    type: contractType(field.type),
});
function contractType(type: TypeDef): unknown {
    switch (type.kind) {
        case "string": {
            const constraint = type.value.constraint;
            return {
                ...type,
                value: {
                    constraint:
                        constraint?.kind === "enum"
                            ? {
                                  ...constraint,
                                  value: {
                                      ...constraint.value,
                                      options: constraint.value.options.map((option) => ({
                                          value: option.value,
                                      })),
                                  },
                              }
                            : constraint,
                },
            };
        }
        case "struct":
            return { ...type, value: { ...type.value, fields: type.value.fields.map(contractField) } };
        case "union":
            return {
                ...type,
                value: {
                    ...type.value,
                    variants: type.value.variants.map((variant) => ({
                        ...variant,
                        type: contractType(variant.type),
                    })),
                },
            };
        case "list":
            return { ...type, value: { ...type.value, elementType: contractType(type.value.elementType) } };
        case "map":
            return {
                ...type,
                value: {
                    ...type.value,
                    keyType: contractType(type.value.keyType),
                    valueType: contractType(type.value.valueType),
                },
            };
        case "optional":
        case "encrypted":
            return { ...type, value: { ...type.value, type: contractType(type.value.type) } };
        case "result":
            return {
                ...type,
                value: {
                    ...type.value,
                    okType: contractType(type.value.okType),
                    errType: contractType(type.value.errType),
                },
            };
        default:
            return type;
    }
}
const contractQuery = (query: QueryDocument) => ({
    ...query,
    inputs: query.inputs?.map(contractField),
});

/** Execution/wire identity, excluding presentation and provider ids on explicit definition nodes.
 * Retains action logic/defaults, policy expressions, literal values, provider
 * metadata and all type constraints. This is not a schema migration policy.
 */
export function ontologyDefinitionContractSignature(ir: OntologyIR): string {
    return memoize(contractSignatures, ir, () => contractSignature(ir));
}
function contractSignature(ir: OntologyIR): string {
    const definition = decodeDefinition(ir);
    return encodeValue({
        ...contractNode(definition),
        types: definition.types.map((type) => ({ ...contractNode(type), type: contractType(type.type) })),
        objectTypes: definition.objectTypes.map((object) => ({
            ...contractNode(object),
            properties: object.properties.map(contractField),
        })),
        linkTypes: definition.linkTypes.map((link) => ({
            ...contractNode(link),
            source: contractNode(link.source),
            target: contractNode(link.target),
        })),
        actionTypes: definition.actionTypes.map((action) => ({
            ...contractNode(action),
            parameters: action.parameters.map(contractField),
            returnType: action.returnType && contractType(action.returnType),
        })),
        queryFunctionTypes: definition.queryFunctionTypes.map((query) => ({
            ...contractNode(query),
            parameters: query.parameters.map(contractField),
            returnType: contractType(query.returnType),
        })),
        context: definition.context && {
            ...definition.context,
            type: definition.context.type && contractType(definition.context.type),
        },
        policy: definition.policy && {
            ...definition.policy,
            objects: contractQuery(definition.policy.objects),
            actions: definition.policy.actions?.map((action) => ({
                ...action,
                additionalObjects: action.additionalObjects && contractQuery(action.additionalObjects),
            })),
            queryFunctions: definition.policy.queryFunctions?.map((query) => ({
                ...query,
                additionalObjects: query.additionalObjects && contractQuery(query.additionalObjects),
            })),
        },
    });
}

const definitionHashes = new WeakMap<object, string>();
const contractHashes = new WeakMap<object, string>();
const cachedHash = (cache: WeakMap<object, string>, ir: OntologyIR, signature: (ir: OntologyIR) => string) =>
    Effect.suspend(() => {
        const cached = cache.get(ir);
        if (cached !== undefined) return Effect.succeed(cached);
        return Effect.try({ try: () => signature(ir), catch: (cause) => cause }).pipe(
            Effect.flatMap((text) =>
                digestBytes({ type: "application/json", stream: Stream.make(new TextEncoder().encode(text)) })
            ),
            Effect.tap((hash) => Effect.sync(() => cache.set(ir, hash)))
        );
    });
/** SHA-256 of {@link ontologyDefinitionSignature}, cached per definition object. */
export const ontologyDefinitionHash = (ir: OntologyIR): Effect.Effect<string, unknown> =>
    cachedHash(definitionHashes, ir, ontologyDefinitionSignature);
/** SHA-256 of {@link ontologyDefinitionContractSignature}, cached per definition object. */
export const ontologyDefinitionContractHash = (ir: OntologyIR): Effect.Effect<string, unknown> =>
    cachedHash(contractHashes, ir, ontologyDefinitionContractSignature);
