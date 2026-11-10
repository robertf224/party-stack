import { makeConnectManager, acquireConfiguredConnection } from "@party-stack/connect";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { Runtimes, Runtime } from "@party-stack/runtime";
import { Effect } from "effect";
import { makeSalesforceMetadataBackend } from "../connect.js";
import { makeSalesforceServiceConnector } from "../serviceConnector.js";
import { salesforceCrudActionTypeName } from "../utils/ids.js";
import type { SalesforceOAuthConnectionOptions } from "../connectionOptions.js";
import type { SalesforceCrudActionTypeSelection } from "../crud.js";
import type { OntologyPullConfig } from "@party-stack/ontology-backend/meta";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

export interface SalesforceOntologyPullConnectionOptions {
    oauth?: SalesforceOAuthConnectionOptions;
    token?: string;
    userId?: string;
}

export interface SalesforcePullBackendOptions {
    instanceUrl: string;
    apiVersion: string;
    ontologyId: string;
    objectTypeNames: string[];
    flowActionTypeNames?: string[];
    standardActionTypeNames?: string[];
    standardQueryFunctionTypeNames?: string[];
    crudActionTypes?: readonly SalesforceCrudActionTypeSelection[];
    connection: SalesforceOntologyPullConnectionOptions;
}

function scopeObjectReferences(type: TypeDef, objectTypeNames: ReadonlySet<string>): TypeDef {
    switch (type.kind) {
        case "objectReference":
            return objectTypeNames.has(type.value.objectType) ? type : { kind: "string", value: {} };
        case "list":
            return {
                ...type,
                value: {
                    ...type.value,
                    elementType: scopeObjectReferences(type.value.elementType, objectTypeNames),
                },
            };
        case "map":
            return {
                ...type,
                value: {
                    ...type.value,
                    keyType: scopeObjectReferences(type.value.keyType, objectTypeNames),
                    valueType: scopeObjectReferences(type.value.valueType, objectTypeNames),
                },
            };
        case "struct":
            return {
                ...type,
                value: {
                    ...type.value,
                    fields: type.value.fields.map((field) => ({
                        ...field,
                        type: scopeObjectReferences(field.type, objectTypeNames),
                    })),
                },
            };
        case "union":
            return {
                ...type,
                value: {
                    ...type.value,
                    variants: type.value.variants.map((variant) => ({
                        ...variant,
                        type: scopeObjectReferences(variant.type, objectTypeNames),
                    })),
                },
            };
        case "optional":
            return {
                ...type,
                value: {
                    ...type.value,
                    type: scopeObjectReferences(type.value.type, objectTypeNames),
                },
            };
        case "result":
            return {
                ...type,
                value: {
                    ...type.value,
                    okType: scopeObjectReferences(type.value.okType, objectTypeNames),
                    errType: scopeObjectReferences(type.value.errType, objectTypeNames),
                },
            };
        default:
            return type;
    }
}

function scopePulledOntology(ontology: OntologyIR): OntologyIR {
    const objectTypeNames = new Set(ontology.objectTypes.map((objectType) => objectType.name));
    const scope = (type: TypeDef) => scopeObjectReferences(type, objectTypeNames);
    return {
        ...ontology,
        types: ontology.types.map((type) => ({
            ...type,
            type: scope(type.type),
        })),
        objectTypes: ontology.objectTypes.map((objectType) => ({
            ...objectType,
            properties: objectType.properties.map((property) => ({
                ...property,
                type: scope(property.type),
            })),
        })),
        actionTypes: ontology.actionTypes.map((actionType) => ({
            ...actionType,
            ...(actionType.returnType ? { returnType: scope(actionType.returnType) } : {}),
            parameters: actionType.parameters.map((parameter) => ({
                ...parameter,
                type: scope(parameter.type),
            })),
        })),
        queryFunctionTypes: ontology.queryFunctionTypes.map((queryFunctionType) => ({
            ...queryFunctionType,
            parameters: queryFunctionType.parameters.map((parameter) => ({
                ...parameter,
                type: scope(parameter.type),
            })),
            returnType: scope(queryFunctionType.returnType),
        })),
        context: ontology.context
            ? { ...ontology.context, type: ontology.context.type ? scope(ontology.context.type) : undefined }
            : undefined,
    };
}

export const makeSalesforcePullBackend = Effect.fn("Salesforce.makePullBackend")(function* (
    options: SalesforcePullBackendOptions
) {
    const oauth = options.connection.oauth;
    const identity = `salesforce:${options.instanceUrl}:${oauth?.clientId ?? "api-key"}:${[...(oauth?.scopes ?? ["api", "refresh_token", "openid"])].sort().join(",")}`;
    const runtimes = yield* Runtimes;
    const runtime = yield* runtimes
        .acquire({ owner: "connect", namespace: identity })
        .pipe(Effect.mapError((cause) => classifyBackendFailure("pull.runtime", cause)));
    const manager = yield* makeConnectManager({
        services: [
            {
                connector: makeSalesforceServiceConnector({
                    loginUrl: oauth?.loginUrl,
                    fetch: oauth?.fetch,
                }),
                instances: [
                    {
                        id: options.instanceUrl,
                        title: "Salesforce",
                        instanceUrl: options.instanceUrl,
                        OAuthApplications: oauth
                            ? [
                                  {
                                      id: oauth.clientId,
                                      title: "Salesforce",
                                      clientId: oauth.clientId,
                                      scopes: oauth.scopes,
                                      redirectUrl: oauth.redirectUrl,
                                      flow: "authorization-code",
                                  },
                              ]
                            : [],
                    },
                ],
            },
        ],
    }).pipe(Effect.provideService(Runtime, runtime));
    const access = yield* acquireConfiguredConnection({
        manager,
        serviceInstanceId: options.instanceUrl,
        userId: options.connection.userId,
        apiKey: options.connection.token,
        oauth: oauth ? { applicationId: oauth.clientId, redirectUrl: oauth.redirectUrl } : undefined,
        browserAuthentication: runtimes.browserAuthentication ?? runtime.browserAuthentication,
    });
    return yield* makeSalesforceMetadataBackend({ ...options, egress: access.egress });
});

export type SalesforceOntologyPullConfig = OntologyPullConfig<Runtimes>;

export interface CreateSalesforceOntologyPullConfigOptions extends SalesforcePullBackendOptions {
    flowActionTypeNames: string[];
    queryFunctionTypeNames?: string[];
    transformPulledOntology?: (ontology: OntologyIR) => OntologyIR | Promise<OntologyIR>;
}

export function createSalesforceOntologyPullConfig(
    options: CreateSalesforceOntologyPullConfigOptions
): SalesforceOntologyPullConfig {
    const objectTypeNames = new Set(options.objectTypeNames);
    for (const selection of options.crudActionTypes ?? []) {
        if (!objectTypeNames.has(selection.objectType)) {
            throw new Error(
                `Salesforce CRUD object type "${selection.objectType}" must also appear in objectTypeNames.`
            );
        }
    }
    const crudActionTypeNames = (options.crudActionTypes ?? []).flatMap((selection) =>
        selection.operations.map((operation) => salesforceCrudActionTypeName(operation, selection.objectType))
    );
    return {
        backend: makeSalesforcePullBackend(options),
        async transformPulledOntology(ontology) {
            const scoped = scopePulledOntology(ontology);
            return options.transformPulledOntology ? options.transformPulledOntology(scoped) : scoped;
        },
        objectTypeNames: options.objectTypeNames,
        actionTypeNames: [
            ...options.flowActionTypeNames,
            ...(options.standardActionTypeNames ?? []),
            ...crudActionTypeNames,
        ],
        queryFunctionTypeNames: [
            ...(options.queryFunctionTypeNames ?? []),
            ...(options.standardQueryFunctionTypeNames ?? []),
        ],
    };
}
