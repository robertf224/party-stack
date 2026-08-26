import { createOntologyClient } from "@party-stack/foundry-client";
import {
    createOntologyBackendInstallation,
    type LiveOntologyWrites,
    type OntologyBackendInstallation,
    type OntologyRoute,
} from "@party-stack/ontology";
import type { BackendConnectionAdapterProvider } from "@party-stack/connections";
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

export type FoundryConnectionOptions = Omit<CreateFoundryConnectionAdapterOptions, "baseUrl">;

export interface CreateFoundryBackendInstallationOptions<
    AuthenticationClient extends object = FoundryAuthenticationClient,
> {
    installationId?: string;
    baseUrl: string;
    runtime: RuntimeAdapterProvider;
    connections: FoundryConnectionOptions | BackendConnectionAdapterProvider<AuthenticationClient>;
    routes: readonly OntologyRoute[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
}

export function createFoundryOntologyRoute(options: {
    ontologyId: string;
    ir: OntologyIR;
    baseUrl: string;
    users?: FoundryUsersIntegration | ((userId: string) => FoundryUsersIntegration);
    persistObjects?: boolean;
    writes?: LiveOntologyWrites;
}): OntologyRoute {
    return {
        matches: (ontologyId) => ontologyId === options.ontologyId,
        configure: ({ connection, egress }) => {
            const client = createOntologyClient({
                baseUrl: options.baseUrl,
                ontologyRid: options.ontologyId,
                // Authentication is applied by ConnectionEgress. This
                // placeholder only satisfies the current OSDK client context.
                tokenProvider: () =>
                    Promise.reject(
                        new Error(
                            "Token access is unavailable; authentication is applied by connection egress."
                        )
                    ),
                fetch: egress.fetch,
                createWebSocket: (url, protocols) => egress.createWebSocket(url, protocols),
            });
            return {
                ir: options.ir,
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
        },
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
        routes: options.routes,
        createContext: options.createContext,
    });
}
