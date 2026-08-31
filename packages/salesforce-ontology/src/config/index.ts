import type {
    Connection,
} from "@party-stack/connections";
import type {
    OntologyPullConfig,
    OntologyPullSource,
    OntologyIR,
    TypeDef,
} from "@party-stack/ontology";
import {
    type SalesforceAuthenticationClient,
    type SalesforceOAuthConnectionOptions,
} from "../connection.js";
import {
    createSalesforceBackendInstallation,
    createSalesforceOntologyRoute,
} from "../installation/createSalesforceBackendInstallation.js";

export interface SalesforceOntologyPullConnectionOptions {
    oauth?: SalesforceOAuthConnectionOptions;
    token?: string;
    userId?: string;
}

export interface CreateSalesforceOntologyPullSourceOptions {
    instanceUrl: string;
    apiVersion: string;
    ontologyId: string;
    objectTypeNames: string[];
    actionTypeNames?: string[];
    connection: SalesforceOntologyPullConnectionOptions;
    transformPulledOntology?: (
        ontology: OntologyIR
    ) => OntologyIR | Promise<OntologyIR>;
}

function scopeObjectReferences(
    type: TypeDef,
    objectTypeNames: ReadonlySet<string>
): TypeDef {
    switch (type.kind) {
        case "objectReference":
            return objectTypeNames.has(
                type.value.objectType
            )
                ? type
                : { kind: "string", value: {} };
        case "list":
            return {
                ...type,
                value: {
                    ...type.value,
                    elementType: scopeObjectReferences(
                        type.value.elementType,
                        objectTypeNames
                    ),
                },
            };
        case "map":
            return {
                ...type,
                value: {
                    ...type.value,
                    keyType: scopeObjectReferences(
                        type.value.keyType,
                        objectTypeNames
                    ),
                    valueType: scopeObjectReferences(
                        type.value.valueType,
                        objectTypeNames
                    ),
                },
            };
        case "struct":
            return {
                ...type,
                value: {
                    ...type.value,
                    fields: type.value.fields.map(
                        (field) => ({
                            ...field,
                            type: scopeObjectReferences(
                                field.type,
                                objectTypeNames
                            ),
                        })
                    ),
                },
            };
        case "union":
            return {
                ...type,
                value: {
                    ...type.value,
                    variants: type.value.variants.map(
                        (variant) => ({
                            ...variant,
                            type: scopeObjectReferences(
                                variant.type,
                                objectTypeNames
                            ),
                        })
                    ),
                },
            };
        case "optional":
            return {
                ...type,
                value: {
                    ...type.value,
                    type: scopeObjectReferences(
                        type.value.type,
                        objectTypeNames
                    ),
                },
            };
        case "result":
            return {
                ...type,
                value: {
                    ...type.value,
                    okType: scopeObjectReferences(
                        type.value.okType,
                        objectTypeNames
                    ),
                    errType: scopeObjectReferences(
                        type.value.errType,
                        objectTypeNames
                    ),
                },
            };
        default:
            return type;
    }
}

function scopePulledOntology(
    ontology: OntologyIR
): OntologyIR {
    const objectTypeNames = new Set(
        ontology.objectTypes.map(
            (objectType) => objectType.name
        )
    );
    const scope = (type: TypeDef) =>
        scopeObjectReferences(type, objectTypeNames);
    return {
        ...ontology,
        types: ontology.types.map((type) => ({
            ...type,
            type: scope(type.type),
        })),
        objectTypes: ontology.objectTypes.map(
            (objectType) => ({
                ...objectType,
                properties: objectType.properties.map(
                    (property) => ({
                        ...property,
                        type: scope(property.type),
                    })
                ),
            })
        ),
        actionTypes: ontology.actionTypes.map(
            (actionType) => ({
                ...actionType,
                parameters: actionType.parameters.map(
                    (parameter) => ({
                        ...parameter,
                        type: scope(parameter.type),
                    })
                ),
            })
        ),
        queryFunctionTypes:
            ontology.queryFunctionTypes.map(
                (queryFunctionType) => ({
                    ...queryFunctionType,
                    parameters:
                        queryFunctionType.parameters.map(
                            (parameter) => ({
                                ...parameter,
                                type: scope(
                                    parameter.type
                                ),
                            })
                        ),
                    returnType: scope(
                        queryFunctionType.returnType
                    ),
                })
            ),
        contextType: ontology.contextType
            ? scope(ontology.contextType)
            : undefined,
    };
}

export function createSalesforceOntologyPullSource(
    options: CreateSalesforceOntologyPullSourceOptions
): OntologyPullSource<SalesforceAuthenticationClient> {
    return {
        ontologyId: options.ontologyId,
        createInstallation: ({ runtime }) =>
            createSalesforceBackendInstallation({
                installationId:
                    `salesforce-pull:${options.instanceUrl}:${options.ontologyId}`,
                instanceUrl: options.instanceUrl,
                apiVersion: options.apiVersion,
                runtime,
                connections: {
                    token: options.connection.token,
                    userId: options.connection.userId,
                    oauth: options.connection.oauth,
                },
                routes: [
                    createSalesforceOntologyRoute({
                        ontologyId: options.ontologyId,
                        objectTypeNames:
                            options.objectTypeNames,
                        actionTypeNames:
                            options.actionTypeNames,
                    }),
                ],
            }),
        async resolveConnection(installation) {
            const configuredUserId =
                options.connection.userId;
            const activeConnections = [
                ...installation.connections.values(),
            ]
                .filter(
                    (connection) =>
                        connection.state.status === "active"
                )
                .map(
                    (
                        connection
                    ): Connection<"active"> => ({
                        userId: connection.userId,
                        state: connection.state as Connection<"active">["state"],
                    })
                );

            if (
                !options.connection.token &&
                !configuredUserId &&
                activeConnections.length > 1
            ) {
                throw new Error(
                    "Multiple Salesforce users are signed in for this project. Set connection.userId in the ontology pull source."
                );
            }
            let connection = options.connection.token
                ? await installation.authentication.signIn.accessToken({
                      userId: configuredUserId,
                  })
                : configuredUserId
                  ? activeConnections.find(
                        (candidate) =>
                            candidate.userId ===
                            configuredUserId
                    )
                  : activeConnections[0];
            if (
                !connection &&
                options.connection.oauth
            ) {
                connection =
                    await installation.authentication.signIn.oauth();
            }
            if (!connection) {
                throw new Error(
                    "Salesforce ontology pull requires connection.oauth or connection.token."
                );
            }
            if (
                configuredUserId &&
                connection.userId !== configuredUserId
            ) {
                throw new Error(
                    `Salesforce signed in as "${connection.userId}", but connection.userId is "${configuredUserId}".`
                );
            }
            return connection;
        },
        async transformPulledOntology(ontology) {
            const scoped =
                scopePulledOntology(ontology);
            return options.transformPulledOntology
                ? options.transformPulledOntology(
                      scoped
                  )
                : scoped;
        },
    };
}

export type SalesforceOntologyPullConfig =
    OntologyPullConfig<SalesforceAuthenticationClient>;

export interface CreateSalesforceOntologyPullConfigOptions
    extends CreateSalesforceOntologyPullSourceOptions {
    actionTypeNames: string[];
    queryFunctionTypeNames?: string[];
}

export function createSalesforceOntologyPullConfig(
    options: CreateSalesforceOntologyPullConfigOptions
): SalesforceOntologyPullConfig {
    return {
        source: createSalesforceOntologyPullSource(options),
        objectTypeNames: options.objectTypeNames,
        actionTypeNames: options.actionTypeNames,
        queryFunctionTypeNames:
            options.queryFunctionTypeNames ?? [],
    };
}
