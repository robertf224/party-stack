import { makeConnectManager, acquireConfiguredConnection } from "@party-stack/connect";
import { nodeRuntime } from "@party-stack/node-runtime";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { makeSalesforceServiceConnector } from "@party-stack/salesforce-ontology";
import { makeSalesforceConnectionClient } from "@party-stack/salesforce-ontology/connect";
import { Effect, Scope, Exit, Layer, Schema } from "effect";

function required(name) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    return value;
}

export async function createLocalSalesforceSession() {
    const clientId = required("SALESFORCE_CLIENT_ID");
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET?.trim();
    const instanceUrl = required("SALESFORCE_INSTANCE_URL").replace(/\/+$/, "");
    const loginUrl = process.env.SALESFORCE_LOGIN_URL?.trim() || instanceUrl;
    const redirectUrl = process.env.SALESFORCE_REDIRECT_URL?.trim() || "http://localhost:1717/oauth/callback";
    const apiVersion = process.env.SALESFORCE_API_VERSION?.trim() || "65.0";
    const scope = Effect.runSync(Scope.make());
    try {
        const opened = await Effect.runPromise(
            Scope.provide(
                Effect.gen(function* () {
                    const environment = yield* Layer.build(nodeRuntime());
                    return yield* Effect.gen(function* () {
                        const runtimes = yield* Runtimes;
                        const runtime = yield* runtimes.acquire({
                            owner: "connect",
                            namespace: `salesforce:${instanceUrl}:${clientId}`,
                        });
                        const manager = yield* makeConnectManager({
                            services: [
                                {
                                    connector: makeSalesforceServiceConnector({ loginUrl }),
                                    instances: [
                                        {
                                            id: instanceUrl,
                                            title: "Salesforce",
                                            instanceUrl,
                                            OAuthApplications: [
                                                {
                                                    id: clientId,
                                                    title: "Salesforce CLI",
                                                    clientId,
                                                    redirectUrl,
                                                    flow: clientSecret
                                                        ? "client-credentials"
                                                        : "authorization-code",
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        }).pipe(Effect.provideService(Runtime, runtime));
                        let access;
                        if (clientSecret) {
                            const application = yield* manager.store.get("OAuthApplication", clientId);
                            yield* manager.store.put("OAuthApplication", {
                                ...application,
                                clientSecret: yield* manager.values.encrypt(Schema.String, clientSecret),
                            });
                            const receipt = yield* manager.backend.applyAction({
                                id: crypto.randomUUID(),
                                name: "connectClientCredentials",
                                parameters: { applicationId: clientId },
                            });
                            access = yield* manager.connections.acquire({
                                objectType: "OAuthConnection",
                                id: receipt.result.connectionId,
                            });
                        } else
                            access = yield* acquireConfiguredConnection({
                                manager,
                                serviceInstanceId: instanceUrl,
                                userId: process.env.SALESFORCE_USER_ID,
                                oauth: { applicationId: clientId, redirectUrl },
                                browserAuthentication: runtimes.browserAuthentication,
                            });
                        return {
                            client: yield* makeSalesforceConnectionClient({
                                instanceUrl,
                                apiVersion,
                                egress: access.egress,
                            }),
                            session: { userId: access.userId },
                            apiVersion,
                            instanceUrl,
                        };
                    }).pipe(Effect.provideContext(environment));
                }),
                scope
            )
        );
        return { ...opened, cleanup: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
    } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(error)));
        throw error;
    }
}
