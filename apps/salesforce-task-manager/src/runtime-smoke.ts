import { createNodeRuntime } from "@party-stack/node-runtime";
import {
    createSalesforceBackendInstallation,
    createSalesforceOntologyRoute,
} from "@party-stack/salesforce-ontology";
import { queryOnce } from "@tanstack/db";
import ontology from "./ontology/ontology.js";
import {
    getSalesforceSettings,
    SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
} from "./settings.js";
import type { SalesforceTaskManagerOntology } from "./ontology/generated/types.js";

const settings = getSalesforceSettings();
const installationId =
    `salesforce-pull:${settings.instanceUrl}:${SALESFORCE_TASK_MANAGER_ONTOLOGY_ID}`;
const installation =
    await createSalesforceBackendInstallation({
        installationId,
        instanceUrl: settings.instanceUrl,
        apiVersion: settings.apiVersion,
        runtime: createNodeRuntime,
        connections: {
            oauth: {
                clientId: settings.clientId,
                redirectUrl:
                    settings.redirectUrl,
                loginUrl: settings.loginUrl,
            },
        },
        routes: [
            createSalesforceOntologyRoute({
                ontologyId:
                    SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
                ir: ontology,
                persistObjects: false,
            }),
        ],
    });

try {
    const restored = [
        ...installation.connections.values(),
    ].find(
        (connection) =>
            connection.state.status === "active" &&
            (!settings.userId ||
                connection.userId === settings.userId)
    );
    const connection =
        restored ??
        (await installation.authentication.signIn.oauth());
    const live =
        await installation.openOntology<SalesforceTaskManagerOntology>({
            userId: connection.userId,
            ontologyId:
                SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
        });
    const Task = live.objects.Task;
    if (!Task) {
        throw new Error(
            "Generated ontology does not contain Task."
        );
    }

    const tasks = await queryOnce((query) =>
        query
            .from({ Task })
            .select(({ Task }) => ({ ...Task }))
            .orderBy(
                ({ Task }) => Task.CreatedDate,
                "desc"
            )
            .limit(5)
    );

    console.log(
        `Runtime opened generated Salesforce ontology and loaded ${tasks.length} Task records.`
    );
} finally {
    console.log("Cleaning up runtime installation.");
    await installation.cleanup();
    console.log("Runtime installation cleanup complete.");
}

process.exit(0);
