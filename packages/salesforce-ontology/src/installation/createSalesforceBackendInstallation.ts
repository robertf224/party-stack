import {
    createMetaOntologyConfiguration,
    createOntologyBackendInstallation,
    type ConfigureOntologyOptions,
    type LiveOntologyWrites,
    type OntologyBackendInstallation,
    type OntologyConfiguration,
    type OntologyIR,
    type OntologyRoute,
} from "@party-stack/ontology";
import {
    createSalesforceClient,
    type SalesforceChangeEvent,
    type SalesforceChangeEventSubscription,
    type SalesforceChangeEventSubscriptionOptions,
} from "@party-stack/salesforce-client";
import { createSalesforceOntologyBackend } from "../adapter/createSalesforceOntologyBackendAdapter.js";
import {
    createSalesforceConnectionAdapter,
    type CreateSalesforceConnectionAdapterOptions,
    type SalesforceAuthenticationClient,
} from "../connection.js";
import { createSalesforceMetaOntologyBackendAdapter } from "../meta/createSalesforceMetaOntologyBackendAdapter.js";
import type { SalesforceCrudActionTypeSelection } from "../crud.js";
import type { BackendConnectionAdapterProvider, ConnectionEgress } from "@party-stack/connect";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";

export type SalesforceConnectionOptions = Omit<
    CreateSalesforceConnectionAdapterOptions,
    "instanceUrl" | "apiVersion"
>;

export type SalesforceOntologyRoute = (options: {
    instanceUrl: string;
    apiVersion: string;
    subscribeToChangeEvents?: (
        userId: string,
        objectType: string,
        listener: (event: SalesforceChangeEvent) => void,
        subscriptionOptions?: SalesforceChangeEventSubscriptionOptions
    ) => Promise<SalesforceChangeEventSubscription>;
}) => OntologyRoute;

export interface CreateSalesforceBackendInstallationOptions<
    AuthenticationClient extends object = SalesforceAuthenticationClient,
> {
    installationId?: string;
    instanceUrl: string;
    apiVersion: string;
    runtime: RuntimeAdapterProvider;
    connections: SalesforceConnectionOptions | BackendConnectionAdapterProvider<AuthenticationClient>;
    routes: readonly SalesforceOntologyRoute[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
}

function createConnectionSalesforceClient(options: {
    instanceUrl: string;
    apiVersion: string;
    egress: ConnectionEgress;
}) {
    return createSalesforceClient({
        instanceUrl: options.instanceUrl,
        apiVersion: options.apiVersion,
        authenticatedFetch: true,
        fetch: (input, init) => options.egress.fetch(new Request(input, init)),
    });
}

function configureSalesforceMeta(
    instanceUrl: string,
    apiVersion: string,
    objectTypeNames: string[] | undefined,
    flowActionTypeNames: string[] | undefined,
    standardActionTypeNames: string[] | undefined,
    standardQueryFunctionTypeNames: string[] | undefined,
    crudActionTypes: readonly SalesforceCrudActionTypeSelection[] | undefined,
    options: ConfigureOntologyOptions
): OntologyConfiguration {
    const client = createConnectionSalesforceClient({
        instanceUrl,
        apiVersion,
        egress: options.egress,
    });
    return createMetaOntologyConfiguration({
        backend: () =>
            createSalesforceMetaOntologyBackendAdapter({
                client,
                objectTypeNames,
                flowActionTypeNames,
                standardActionTypeNames,
                standardQueryFunctionTypeNames,
                crudActionTypes,
            }),
    });
}

export function createSalesforceOntologyRoute(options: {
    ontologyId: string;
    ir?: OntologyIR;
    objectTypeNames?: string[];
    flowActionTypeNames?: string[];
    standardActionTypeNames?: string[];
    standardQueryFunctionTypeNames?: string[];
    crudActionTypes?: readonly SalesforceCrudActionTypeSelection[];
    live?: boolean;
    persistObjects?: boolean;
    writes?: LiveOntologyWrites;
}): SalesforceOntologyRoute {
    return ({ instanceUrl, apiVersion, subscribeToChangeEvents }) => {
        const route: OntologyRoute = {
            matches: (ontologyId) => ontologyId === options.ontologyId,
        };
        const ir = options.ir;
        if (ir) {
            route.configure = ({ egress, connection }) => {
                const client = createConnectionSalesforceClient({
                    instanceUrl,
                    apiVersion,
                    egress,
                });
                return {
                    ir,
                    backend: createSalesforceOntologyBackend({
                        client,
                        live: options.live,
                        subscribeToChangeEvents: subscribeToChangeEvents
                            ? (objectType, listener, subscriptionOptions) =>
                                  subscribeToChangeEvents(
                                      connection.userId,
                                      objectType,
                                      listener,
                                      subscriptionOptions
                                  )
                            : undefined,
                    }),
                    persistObjects: options.persistObjects,
                    writes: options.writes,
                };
            };
        }
        route.configureMeta = (configureOptions) =>
            configureSalesforceMeta(
                instanceUrl,
                apiVersion,
                options.objectTypeNames,
                options.flowActionTypeNames,
                options.standardActionTypeNames,
                options.standardQueryFunctionTypeNames,
                options.crudActionTypes,
                configureOptions
            );
        return route;
    };
}

export function createSalesforceBackendInstallation<
    AuthenticationClient extends object = SalesforceAuthenticationClient,
>(
    options: CreateSalesforceBackendInstallationOptions<AuthenticationClient>
): Promise<OntologyBackendInstallation<AuthenticationClient>> {
    let installation: OntologyBackendInstallation<AuthenticationClient> | undefined;
    const subscribeToChangeEvents =
        typeof options.connections === "function"
            ? undefined
            : (
                  userId: string,
                  objectType: string,
                  listener: (event: SalesforceChangeEvent) => void,
                  subscriptionOptions?: SalesforceChangeEventSubscriptionOptions
              ) => {
                  if (!installation) {
                      throw new Error("Salesforce installation is not ready.");
                  }
                  return (
                      installation.authentication as unknown as SalesforceAuthenticationClient
                  ).subscribeToChangeEvents(userId, objectType, listener, subscriptionOptions);
              };
    const connectionAdapter =
        typeof options.connections === "function"
            ? options.connections
            : (createSalesforceConnectionAdapter({
                  ...options.connections,
                  instanceUrl: options.instanceUrl,
                  apiVersion: options.apiVersion,
              }) as BackendConnectionAdapterProvider<AuthenticationClient>);
    return createOntologyBackendInstallation<AuthenticationClient>({
        installationId: options.installationId ?? `salesforce:${new URL(options.instanceUrl).origin}`,
        connections: connectionAdapter,
        runtime: options.runtime,
        routes: options.routes.map((route) =>
            route({
                instanceUrl: options.instanceUrl,
                apiVersion: options.apiVersion,
                subscribeToChangeEvents,
            })
        ),
        createContext: options.createContext,
    }).then((created) => {
        installation = created;
        return created;
    });
}
