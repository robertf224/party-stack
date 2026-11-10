import { makeConnectManager, acquireConfiguredConnection } from "@party-stack/connect";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { Runtimes, Runtime } from "@party-stack/runtime";
import { Effect } from "effect";
import { makeFoundryMetadataBackend } from "../backend.js";
import { makeFoundryServiceConnector } from "../serviceConnector.js";
import type { FoundryOAuthConnectionOptions } from "../connectionOptions.js";
import type { OntologyPullConfig } from "@party-stack/ontology-backend/meta";

const DEFAULT_FOUNDRY_SCOPES = [
    "api:use-ontologies-read",
    "offline_access",
    "ontology:view-unredacted-action-type",
    "ontology:view-object-type",
];

export interface FoundryOntologyPullConnectionOptions {
    oauth?: FoundryOAuthConnectionOptions;
    token?: string;
    userId?: string;
}

export interface FoundryPullBackendOptions {
    baseUrl: string;
    ontologyRid: string;
    connection: FoundryOntologyPullConnectionOptions;
}

/** Acquire an authenticated metadata backend for the duration of the pull. */
export const makeFoundryPullBackend = Effect.fn("Foundry.makePullBackend")(function* (
    options: FoundryPullBackendOptions
) {
    const scopes = options.connection.oauth?.scopes ?? DEFAULT_FOUNDRY_SCOPES;
    const oauth = options.connection.oauth;
    const identity = `foundry:${options.baseUrl}:${oauth?.clientId ?? "api-key"}:${[...scopes].sort().join(",")}`;
    const runtimes = yield* Runtimes;
    const runtime = yield* runtimes
        .acquire({ owner: "connect", namespace: identity })
        .pipe(Effect.mapError((cause) => classifyBackendFailure("pull.runtime", cause)));
    const manager = yield* makeConnectManager({
        services: [
            {
                connector: makeFoundryServiceConnector({ fetch: oauth?.fetch }),
                instances: [
                    {
                        id: options.baseUrl,
                        title: "Foundry",
                        instanceUrl: options.baseUrl,
                        OAuthApplications: oauth
                            ? [
                                  {
                                      id: oauth.clientId,
                                      title: "Foundry",
                                      clientId: oauth.clientId,
                                      scopes,
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
        serviceInstanceId: options.baseUrl,
        userId: options.connection.userId,
        apiKey: options.connection.token,
        oauth: oauth ? { applicationId: oauth.clientId, redirectUrl: oauth.redirectUrl } : undefined,
        browserAuthentication: runtimes.browserAuthentication ?? runtime.browserAuthentication,
    });
    return yield* makeFoundryMetadataBackend({
        baseUrl: options.baseUrl,
        ontologyId: options.ontologyRid,
        egress: access.egress,
    });
});

export type FoundryOntologyPullConfig = OntologyPullConfig<Runtimes>;
