import { createOntologyClient } from "@party-stack/foundry-client";
import {
    createMetaOntologyConfiguration,
    createOntologyBackendInstallation,
    type LiveOntologyWrites,
    type OntologyBackendInstallation,
    type ConfigureOntologyOptions,
    type OntologyConfiguration,
    type OntologyRoute,
} from "@party-stack/ontology";
import type { BackendConnectionAdapterProvider, ConnectionEgress } from "@party-stack/connections";
import type { OntologyIR } from "@party-stack/ontology";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";
import {
    createFoundryOntologyBackend,
    type FoundryUsersIntegration,
} from "../adapter/createFoundryOntologyBackendAdapter.js";
import {
    createFoundryConnectionAdapter,
    type CreateFoundryConnectionAdapterOptions,
    type FoundryAuthenticationClient,
} from "../connection.js";
import { createFoundryMetaOntologyBackendAdapter } from "../meta/createFoundryMetaOntologyBackendAdapter.js";

export type FoundryConnectionOptions = Omit<CreateFoundryConnectionAdapterOptions, "baseUrl">;
export type FoundryOntologyRoute = (baseUrl: string) => OntologyRoute;

export interface CreateFoundryBackendInstallationOptions<
    AuthenticationClient extends object = FoundryAuthenticationClient,
> {
    installationId?: string;
    baseUrl: string;
    runtime: RuntimeAdapterProvider;
    connections: FoundryConnectionOptions | BackendConnectionAdapterProvider<AuthenticationClient>;
    routes: readonly FoundryOntologyRoute[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
}

function createConnectionOntologyClient(baseUrl: string, ontologyId: string, egress: ConnectionEgress) {
    return createOntologyClient({
        baseUrl,
        ontologyRid: ontologyId,
        // Authentication is applied by ConnectionEgress. This
        // placeholder only satisfies the current OSDK client context.
        tokenProvider: () =>
            Promise.reject(
                new Error("Token access is unavailable; authentication is applied by connection egress.")
            ),
        fetch: egress.fetch,
        createWebSocket: (url, protocols) => egress.createWebSocket(url, protocols),
    });
}

function configureFoundryMeta(baseUrl: string, options: ConfigureOntologyOptions): OntologyConfiguration {
    const client = createConnectionOntologyClient(baseUrl, options.ontologyId, options.egress);
    return createMetaOntologyConfiguration({
        backend: () =>
            createFoundryMetaOntologyBackendAdapter({
                client,
            }),
    });
}

export function createFoundryOntologyRoute(options: {
    ontologyId: string;
    ir?: OntologyIR;
    users?: FoundryUsersIntegration | ((userId: string) => FoundryUsersIntegration);
    persistObjects?: boolean;
    writes?: LiveOntologyWrites;
}): FoundryOntologyRoute {
    return (baseUrl) => {
        const route: OntologyRoute = {
            matches: (ontologyId) => ontologyId === options.ontologyId,
        };
        const ir = options.ir;
        if (ir) {
            route.configure = ({ connection, egress }) => {
                const client = createConnectionOntologyClient(baseUrl, options.ontologyId, egress);
                return {
                    ir,
                    backend: createFoundryOntologyBackend({
                        client,
                        users:
                            typeof options.users === "function"
                                ? options.users(connection.userId)
                                : options.users,
                    }),
                    persistObjects: options.persistObjects ?? true,
                    writes: options.writes,
                };
            };
        } else {
            route.configureMeta = (configureOptions) => configureFoundryMeta(baseUrl, configureOptions);
        }
        return route;
    };
}

export function createFoundryBackendInstallation<
    AuthenticationClient extends object = FoundryAuthenticationClient,
>(
    options: CreateFoundryBackendInstallationOptions<AuthenticationClient>
): Promise<OntologyBackendInstallation<AuthenticationClient>> {
    const connectionAdapter =
        typeof options.connections === "function"
            ? options.connections
            : (createFoundryConnectionAdapter({
                  ...options.connections,
                  baseUrl: options.baseUrl,
              }) as BackendConnectionAdapterProvider<AuthenticationClient>);
    return createOntologyBackendInstallation<AuthenticationClient>({
        installationId: options.installationId ?? new URL(options.baseUrl).origin,
        connections: connectionAdapter,
        runtime: options.runtime,
        routes: options.routes.map((route) => route(options.baseUrl)),
        createContext: options.createContext,
    });
}
