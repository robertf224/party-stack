# salesforce-ontology

Salesforce service integration, metadata, and ontology backends.

## Saved connections and native backends

```ts
import { makeConnectManager } from "@party-stack/connect";
import { makeSalesforceServiceConnector } from "@party-stack/salesforce-ontology";
import { makeSalesforceBackend } from "@party-stack/salesforce-ontology/connect";

const connect =
    yield *
    makeConnectManager({
        services: [
            {
                connector: makeSalesforceServiceConnector({ loginUrl }),
                instances: [
                    {
                        id: "salesforce",
                        title: "Salesforce",
                        instanceUrl,
                        OAuthApplications: [
                            {
                                id: clientId,
                                title: "My app",
                                clientId,
                                redirectUrl,
                                flow: "authorization-code",
                            },
                        ],
                    },
                ],
            },
        ],
    });
const access =
    yield *
    connect.connections.acquire({
        objectType: "OAuthConnection",
        id: connectionId,
    });
const backend =
    yield *
    makeSalesforceBackend({
        instanceUrl: access.serviceInstance.instanceUrl,
        apiVersion: "65.0",
        egress: access.egress,
        ir: generatedOntology,
        context: { user: access.userId },
    });
```

`makeConnectManager` requires `Runtime` and `Scope`. It owns the saved connection
inventory, credential refresh and maintenance. Acquiring a connection creates
scoped authenticated I/O. Each request reads current credentials; an OAuth 401
can request one coordinated refresh and retry.

Mount the public Connect ontology on `makeOntologyServer`, then use
`createAuthenticationClient(...).oauth(...).signIn()` from a browser event handler.
Serve acquired data backends through other routes on the same server. The
Salesforce task manager uses that arrangement in a SharedWorker.

## Pull configuration

Consumer projects can export a standard Party Stack pull configuration:

```ts
import { createSalesforceOntologyPullConfig } from "@party-stack/salesforce-ontology/config";

export default createSalesforceOntologyPullConfig({
    instanceUrl,
    apiVersion: "65.0",
    ontologyId: "salesforce:task-manager",
    objectTypeNames: ["Task", "User"],
    flowActionTypeNames: ["Create_Task_Flow"],
    standardActionTypeNames: ["confirmSalesMeeting"],
    standardQueryFunctionTypeNames: ["getAvailableMeetingTimes"],
    crudActionTypes: [
        {
            objectType: "Task",
            operations: ["create", "update", "delete"],
        },
    ],
    connection: {
        oauth: {
            clientId,
            redirectUrl,
        },
    },
});
```

Running `ontology pull` acquires the native Salesforce metadata backend and emits
`src/ontology/ontology.ts`. It uses the same Connect manager and acquires only authenticated metadata I/O; it does not open a data replica or UI collection.

See `apps/salesforce-task-manager` for a real-org example.

## Metadata backend

`makeSalesforceMetadataBackend({ instanceUrl, apiVersion, egress, ...options })`
from the `connect` export acquires metadata directly. The lower-level adapter
constructors remain available for callers supplying their own Salesforce client.

Unscoped object/action queries load Salesforce catalog summaries only.
Queries using `eq` or `inArray` on `name` push down to the direct describe
endpoints and hydrate just those definitions. This avoids one describe request
per object or action when browsing a large org.

## Scope

- sObject describe → object/link metadata
- Active autolaunched Flows → action metadata and invocation
- Standard invocable actions → actions or explicitly classified query functions
- Describe-backed sObject CRUD actions
- SOQL-backed object collections
- No CDC live sync, Files attachments, or Apex actions in this slice
