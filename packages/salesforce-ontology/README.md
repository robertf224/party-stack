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
