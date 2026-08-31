# salesforce-ontology

Salesforce connection, installation, metadata, and runtime ontology adapters.

## Installation

```ts
import {
    createSalesforceBackendInstallation,
    createSalesforceOntologyRoute,
} from "@party-stack/salesforce-ontology";

const installation =
    await createSalesforceBackendInstallation({
        instanceUrl:
            "https://example.my.salesforce.com",
        apiVersion: "65.0",
        runtime,
        connections: {
            oauth: {
                clientId,
                redirectUrl:
                    "http://localhost:1717/oauth/callback",
            },
        },
        routes: [
            createSalesforceOntologyRoute({
                ontologyId:
                    "salesforce:task-manager",
                ir: generatedOntology,
            }),
        ],
    });
```

The connection adapter uses `@party-stack/oauth`, persists refresh tokens
through the selected runtime, and applies authentication through
`ConnectionEgress`. The Salesforce client and ontology backends remain
token-provider/egress agnostic.

## Pull configuration

Consumer projects can export a standard Party Stack pull configuration:

```ts
import {
    createSalesforceOntologyPullConfig,
} from "@party-stack/salesforce-ontology/config";

export default createSalesforceOntologyPullConfig({
    instanceUrl,
    apiVersion: "65.0",
    ontologyId: "salesforce:task-manager",
    objectTypeNames: ["Task", "User"],
    actionTypeNames: [],
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
import { createSalesforceClient } from "@party-stack/salesforce-client";
import { createSalesforceOntologyBackend } from "@party-stack/salesforce-ontology";
import { createLiveOntology } from "@party-stack/ontology";

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
import { createSalesforceMetaOntologyBackendAdapter } from "@party-stack/salesforce-ontology/meta";
import { createMetaLiveOntology } from "@party-stack/ontology";

const meta = await createMetaLiveOntology({
    backend: () =>
        createSalesforceMetaOntologyBackendAdapter({
            client,
            objectTypeNames: ["Account", "Contact"],
        }),
});
```

## Scope

- sObject describe → object/link metadata
- Active autolaunched Flows → action metadata and invocation
- SOQL-backed object collections
- No CDC live sync, Files attachments, Apex actions, or query functions in this slice
