import { CipherTextProperties } from "@osdk/foundry.ontologies";
import { BackendError } from "@party-stack/ontology-backend";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { Effect, Predicate, Schema } from "effect";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { BackendEncryptedValues } from "@party-stack/ontology-backend";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";

const Ciphertext = Schema.String.check(Schema.isPattern(/^CIPHER::[^:]+::.+::CIPHER$/u));
const Source = Schema.Struct({
    objectType: Schema.String,
    primaryKey: Schema.Union([Schema.String, Schema.Finite]),
    property: Schema.String,
});
const Handle = Schema.Struct({ id: Ciphertext, source: Schema.optional(Source) });

/** Ciphertext is an opaque identifier here, never implicitly decrypted or interpreted as plaintext. */
export function decodeFoundryCiphertext(value: unknown, source?: Encrypted["source"]): Encrypted {
    const handle = Predicate.isString(value)
        ? { id: Schema.decodeUnknownSync(Ciphertext)(value) }
        : Schema.decodeUnknownSync(Handle)(value);
    return source ? { ...handle, source } : handle;
}

export const encodeFoundryCiphertext = (value: unknown): string => Schema.decodeUnknownSync(Handle)(value).id;

const rejected = (operation: string, message: string) =>
    new BackendError({ operation, kind: "Rejected", message, retryable: false });

function requestError(operation: string, cause: unknown): BackendError {
    const status = Predicate.isObject(cause) ? cause.statusCode : undefined;
    // Provider errors and decoder issues may contain sensitive bodies. Preserve the
    // classification, without attaching raw requests, ciphertext or plaintext to traces.
    return new BackendError({
        operation,
        kind: status === 404 ? "NotFound" : status === 401 || status === 403 ? "Rejected" : "Unavailable",
        message: "Foundry CipherText request failed.",
        retryable: status === undefined || status === 429 || (Predicate.isNumber(status) && status >= 500),
    });
}

/** Foundry's property endpoint reads the property's current value; it does not decrypt an arbitrary blob. */
export function makeFoundryEncryptedValues(client: OntologyClient, ir: OntologyIR): BackendEncryptedValues {
    const plaintextSchema = (
        target: NonNullable<Encrypted["source"]>,
        requested: TypeDef,
        operation: string
    ) =>
        Effect.try({
            try: () => {
                const property = ir.objectTypes
                    .find((object) => object.name === target.objectType)
                    ?.properties.find((field) => field.name === target.property);
                if (!property) throw new Error("Unknown CipherText property.");
                let type = resolveType(ir, property.type);
                while (type.kind === "optional") type = resolveType(ir, type.value.type);
                if (type.kind !== "encrypted") throw new Error("The property is not encrypted.");
                if (
                    resolveType(ir, type.value.type).kind !== "string" ||
                    resolveType(ir, requested).kind !== "string"
                )
                    throw new Error("Foundry CipherText plaintext must be a string.");
                const schemas = compileEffectSchemas({
                    types: ir.types,
                    objectTypes: [],
                    linkTypes: [],
                    actionTypes: [],
                    queryFunctionTypes: [
                        {
                            name: "property",
                            displayName: "Property",
                            parameters: [],
                            returnType: type.value.type,
                        },
                        {
                            name: "requested",
                            displayName: "Requested",
                            parameters: [],
                            returnType: requested,
                        },
                    ],
                });
                return schemas.queryReturnSchemas;
            },
            catch: () => rejected(operation, "Expected a known CipherText property with string plaintext."),
        });
    const requestClient = (signal: AbortSignal): OntologyClient => ({
        ...client,
        fetch: (input, init) =>
            client.fetch(input, {
                ...init,
                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            }),
    });
    return {
        decrypt: Effect.fn("Foundry.decrypt")(function* (value, plaintextType) {
            const handle = yield* Effect.try({
                try: () => Schema.decodeUnknownSync(Handle)(value),
                catch: () => rejected("foundry.decrypt", "Invalid Foundry encrypted handle."),
            });
            if (!handle.source)
                return yield* rejected(
                    "foundry.decrypt",
                    "Foundry decryption requires an object property source."
                );
            const schemas = yield* plaintextSchema(handle.source, plaintextType, "foundry.decrypt");
            const result = yield* Effect.tryPromise({
                try: (signal) =>
                    CipherTextProperties.decrypt(
                        requestClient(signal),
                        client.ontologyRid,
                        handle.source!.objectType,
                        String(handle.source!.primaryKey),
                        handle.source!.property
                    ),
                catch: (cause) => requestError("foundry.decrypt", cause),
            });
            return yield* Schema.decodeUnknownEffect(schemas.property!)(result.plaintext).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(schemas.requested!)),
                Effect.mapError(() => rejected("foundry.decrypt", "Invalid decrypted plaintext."))
            );
        }),
    };
}
