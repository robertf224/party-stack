import {
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyIR,
} from "@party-stack/ontology";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { type SalesforceClient } from "@party-stack/salesforce-client";
import { Effect, Redacted, Schema } from "effect";
import { getSalesforceActionMetadata } from "../actionMetadata.js";
import { makeSalesforceBackend } from "./backend.js";
import { createSalesforceCodec } from "./salesforceCodec.js";
import type { ActionReceipt } from "@party-stack/ontology-backend";

const ProviderIssue = Schema.Struct({
    statusCode: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    fields: Schema.optional(Schema.Array(Schema.String)),
});
const SaveResult = Schema.Struct({
    success: Schema.Boolean,
    id: Schema.optional(Schema.String),
    errors: Schema.Array(ProviderIssue),
});
const InvocableResults = Schema.Array(
    Schema.Struct({
        isSuccess: Schema.Boolean,
        errors: Schema.optional(Schema.NullOr(Schema.Array(ProviderIssue))),
        outputValues: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    })
);
const rejected = (operation: string, kind: BackendError["kind"], message: string) =>
    new BackendError({ operation, kind, message, retryable: false, actionOutcome: "not-committed" });
const invalidResponse = (operation: string, cause?: unknown) =>
    new BackendError({
        operation,
        kind: "InvalidResponse",
        message: "Salesforce returned an invalid response.",
        retryable: false,
        actionOutcome: "unknown",
        cause: Redacted.make(cause),
    });
function response<A>(schema: Schema.Decoder<A>, value: unknown, operation: string): A {
    try {
        return Schema.decodeUnknownSync(schema)(value);
    } catch (cause) {
        throw invalidResponse(operation, cause);
    }
}
function providerRejection(operation: string, errors: readonly (typeof ProviderIssue.Type)[]): BackendError {
    const classified = classifyBackendFailure(operation, { errorCode: errors[0]?.statusCode });
    const kind = classified.kind === "Unavailable" ? "ValidationFailed" : classified.kind;
    return new BackendError({
        operation,
        kind,
        message: kind === "ValidationFailed" ? "Submission failed validation." : classified.message,
        retryable: kind === "RateLimited",
        actionOutcome: "not-committed",
        issues:
            kind === "ValidationFailed"
                ? errors.flatMap((error) =>
                      error.message
                          ? [
                                {
                                    message: error.message,
                                    category: "custom" as const,
                                    source: "submission" as const,
                                    messageSource: "configured" as const,
                                },
                            ]
                          : []
                  )
                : undefined,
        cause: Redacted.make(errors),
    });
}
function assertSaveSucceeded(value: unknown) {
    const result = response(SaveResult, value, "salesforce.applyAction");
    if (!result.success) throw providerRejection("salesforce.applyAction", result.errors);
    return result;
}
function invocableResult(value: unknown, operation: string) {
    const results = response(InvocableResults, value, operation);
    if (results.length !== 1) throw invalidResponse(operation);
    const result = results[0]!;
    if (!result.isSuccess) throw providerRejection(operation, result.errors ?? []);
    return result;
}

export function createSalesforceOntologyBackendAdapter(opts: {
    client: SalesforceClient;
    ir: OntologyIR;
}): OntologyBackendAdapter {
    const codec = createSalesforceCodec(opts.ir);
    const encodeInvocableParameter = (
        type: Parameters<typeof codec.encodeValue>[0],
        value: unknown
    ): unknown => {
        if (type.kind === "optional") {
            return encodeInvocableParameter(type.value.type, value);
        }
        if (type.kind === "list" && Array.isArray(value)) {
            return value.map((entry) => codec.encodeValue(type.value.elementType, entry));
        }
        return codec.encodeValue(type, value);
    };

    async function submitAction(
        name: string,
        parameters: Record<string, unknown>,
        client: SalesforceClient = opts.client
    ): Promise<Pick<ActionReceipt, "affected" | "affectedComplete">> {
        const actionType = opts.ir.actionTypes.find((candidate) => candidate.name === name);
        if (!actionType) {
            throw rejected(
                "salesforce.applyAction",
                "InvalidRequest",
                `Unknown Salesforce action type "${name}".`
            );
        }

        const requestParameters: Record<string, unknown> = {};
        try {
            const parameterTypes = new Map(
                actionType.parameters.map((parameter) => [parameter.name, parameter.type])
            );
            for (const [parameterName, value] of Object.entries(parameters)) {
                if (value === undefined) continue;
                const parameterType = parameterTypes.get(parameterName);
                requestParameters[parameterName] = parameterType
                    ? encodeInvocableParameter(parameterType, value)
                    : value;
            }
        } catch (cause) {
            throw new BackendError({
                operation: "salesforce.applyAction",
                kind: "InvalidRequest",
                retryable: false,
                actionOutcome: "not-committed",
                message: "Invalid action parameters.",
                cause: Redacted.make(cause),
            });
        }

        const metadata = getSalesforceActionMetadata(actionType);
        if (!metadata) {
            throw rejected(
                "salesforce.applyAction",
                "InvalidConfiguration",
                `Salesforce action type "${name}" is missing Salesforce metadata.`
            );
        }
        if (metadata.kind === "crud") {
            if (metadata.operation === "create") {
                const result = assertSaveSucceeded(
                    await client.createRecord(metadata.objectType, requestParameters)
                );
                return {
                    affected: [
                        { objectType: metadata.objectType, ...(result.id ? { keys: [result.id] } : {}) },
                    ],
                    affectedComplete: false,
                };
            }
            const recordId = requestParameters.recordId;
            if (typeof recordId !== "string" || recordId.length === 0) {
                throw rejected(
                    "salesforce.applyAction",
                    "InvalidRequest",
                    `Salesforce ${metadata.operation} action requires recordId.`
                );
            }
            if (metadata.operation === "update") {
                const fields = Object.fromEntries(
                    Object.entries(requestParameters).filter(
                        ([parameterName]) => parameterName !== "recordId"
                    )
                );
                const result = await client.updateRecord(metadata.objectType, recordId, fields);
                assertSaveSucceeded(result);
                return {
                    affected: [{ objectType: metadata.objectType, keys: [recordId] }],
                    affectedComplete: false,
                };
            }
            assertSaveSucceeded(await client.deleteRecord(metadata.objectType, recordId));
            return {
                affected: [{ objectType: metadata.objectType, keys: [recordId] }],
                affectedComplete: false,
            };
        }

        const actionApiName = metadata.apiName;

        let results;
        try {
            results =
                metadata.kind === "standard"
                    ? await client.invokeStandardAction(actionApiName, [requestParameters])
                    : await client.invokeFlowAction(actionApiName, [requestParameters]);
        } catch (error) {
            throw classifyBackendFailure("salesforce.applyAction", error);
        }

        invocableResult(results, "salesforce.applyAction");

        // Flows and standard actions can modify records outside their inputs.
        return { affected: opts.ir.objectTypes.map((type) => ({ objectType: type.name })) };
    }

    async function runQueryFunction(
        name: string,
        parameters: Record<string, unknown>,
        client: SalesforceClient = opts.client
    ): Promise<unknown> {
        const queryFunction = opts.ir.queryFunctionTypes.find((candidate) => candidate.name === name);
        if (!queryFunction) {
            throw rejected(
                "salesforce.queryFunction",
                "InvalidRequest",
                `Unknown Salesforce query function type "${name}".`
            );
        }
        const parameterTypes = new Map(
            queryFunction.parameters.map((parameter) => [parameter.name, parameter.type])
        );
        const requestParameters: Record<string, unknown> = {};
        for (const [parameterName, value] of Object.entries(parameters)) {
            if (value === undefined) continue;
            const parameterType = parameterTypes.get(parameterName);
            requestParameters[parameterName] = parameterType
                ? encodeInvocableParameter(parameterType, value)
                : value;
        }
        const results = await client.invokeStandardAction(name, [requestParameters]);
        const result = invocableResult(results, "salesforce.queryFunction");
        try {
            return codec.decodeValue(queryFunction.returnType, result.outputValues ?? {});
        } catch (cause) {
            throw invalidResponse("salesforce.queryFunction", cause);
        }
    }

    return {
        name: "salesforce",
        open: (context) =>
            Effect.succeed(
                makeSalesforceBackend({
                    client: opts.client,
                    context,
                    ir: opts.ir,
                    decodeObject: (objectType, object) => codec.decodeObject(objectType, object),
                    submitAction,
                    runQueryFunction,
                })
            ),
    };
}

export type CreateSalesforceOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (
    | {
          client: SalesforceClient;
      }
    | {
          createClient: (ir: OntologyIR, context: Context) => SalesforceClient | Promise<SalesforceClient>;
      }
) & {};

export function createSalesforceOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateSalesforceOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createSalesforceOntologyBackendAdapter({
            ir,
            client: "client" in opts ? opts.client : await opts.createClient(ir, context),
        });
}
