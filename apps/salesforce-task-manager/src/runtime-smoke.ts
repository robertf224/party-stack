import { makeConnectManager, acquireConfiguredConnection } from "@party-stack/connect";
import { nodeRuntime } from "@party-stack/node-runtime";
import { makeLiveOntology } from "@party-stack/ontology";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { makeSalesforceServiceConnector } from "@party-stack/salesforce-ontology";
import { makeSalesforceBackend } from "@party-stack/salesforce-ontology/connect";
import { queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import ontology from "./ontology/ontology.js";
import { getSalesforceSettings, SALESFORCE_TASK_MANAGER_ONTOLOGY_ID } from "./settings.js";
import type { SalesforceTaskManagerOntology } from "./ontology/generated/types.js";

const settings = getSalesforceSettings();
await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const runtimes = yield* Runtimes;
            const runtime = yield* runtimes.acquire({
                owner: "connect",
                namespace: `salesforce:${settings.instanceUrl}:${settings.clientId}`,
            });
            const manager = yield* makeConnectManager({
                services: [
                    {
                        connector: makeSalesforceServiceConnector({ loginUrl: settings.loginUrl }),
                        instances: [
                            {
                                id: settings.instanceUrl,
                                title: "Salesforce",
                                instanceUrl: settings.instanceUrl,
                                OAuthApplications: [
                                    {
                                        id: settings.clientId,
                                        title: "Task manager",
                                        clientId: settings.clientId,
                                        redirectUrl: settings.redirectUrl,
                                        flow: "authorization-code",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }).pipe(Effect.provideService(Runtime, runtime));
            const access = yield* acquireConfiguredConnection({
                manager,
                serviceInstanceId: settings.instanceUrl,
                userId: settings.userId,
                oauth: { applicationId: settings.clientId, redirectUrl: settings.redirectUrl },
                browserAuthentication: runtimes.browserAuthentication,
            });
            const context = { user: access.userId };
            const backend = yield* makeSalesforceBackend({
                instanceUrl: settings.instanceUrl,
                apiVersion: settings.apiVersion,
                egress: access.egress,
                ir: ontology,
                context,
            });
            const live = yield* makeLiveOntology<SalesforceTaskManagerOntology>({
                id: SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
                ir: ontology,
                context,
                authentication: access.authentication,
                backend,
            });
            const tasks = yield* Effect.promise(() =>
                queryOnce((q) =>
                    q
                        .from({ Task: live.objects.Task })
                        .orderBy(({ Task }) => Task.CreatedDate, "desc")
                        .limit(5)
                )
            );
            console.log(`Runtime loaded ${tasks.length} Salesforce Task records.`);
        })
    ).pipe(Effect.provide(nodeRuntime()))
);
