# salesforce-ontology

Salesforce connection, installation, metadata, and runtime ontology adapters.

## Installation

```ts
import {
    createSalesforceBackendInstallation,
    createSalesforceOntologyRoute,
} from "@party-stack/salesforce-ontology";

const installation = await createSalesforceBackendInstallation({
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "65.0",
    runtime,
    connections: {
        oauth: {
            clientId,
            redirectUrl: "http://localhost:1717/oauth/callback",
        },
    },
    routes: [
        createSalesforceOntologyRoute({
            ontologyId: "salesforce:task-manager",
            ir: generatedOntology,
        }),
    ],
});
```

The connection adapter uses `@party-stack/connect`, persists refresh tokens
through the selected runtime, and applies authentication through
`ConnectionEgress`. The Salesforce client and ontology backends remain
token-provider/egress agnostic.

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

Running `ontology pull` opens the Salesforce metadata ontology and emits the
normal `src/ontology/ontology.ts` consumed by
`createSalesforceOntologyRoute({ ir })`.

See `apps/salesforce-task-manager` for a real-org example.

# salesforce-ontology

Salesforce backend adapters for Party Stack LiveOntology.

## Runtime adapter

```ts
import { createLiveOntology } from "@party-stack/ontology";
import { createSalesforceClient } from "@party-stack/salesforce-client";
import { createSalesforceOntologyBackend } from "@party-stack/salesforce-ontology";

// jsforce-backed client; supply your own token (no OAuth ownership here)
const client = createSalesforceClient({
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL!,
    apiVersion: "61.0",
    tokenProvider: async () => process.env.SALESFORCE_ACCESS_TOKEN!,
});

const ontology = await createLiveOntology({
    ir,
    backend: createSalesforceOntologyBackend({ client }),
});
```

## Metadata adapter

```ts
import { createMetaLiveOntology } from "@party-stack/ontology";
import { createSalesforceMetaOntologyBackendAdapter } from "@party-stack/salesforce-ontology/meta";

const meta = await createMetaLiveOntology({
    backend: () =>
        createSalesforceMetaOntologyBackendAdapter({
            client,
            objectTypeNames: ["Account", "Contact"],
        }),
});
```

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
