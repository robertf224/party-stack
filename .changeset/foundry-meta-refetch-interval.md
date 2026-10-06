---
"@party-stack/foundry-ontology": minor
---

Add an optional `refetchInterval` to the Foundry meta ontology backend adapter and metadata-only ontology routes, and forward it to the shared metadata, action type, and query function type query collections. Set an interval in milliseconds to poll for metadata updates, or `false` to disable polling. Route configuration applies when the installation opens the meta ontology through `openMetaOntology`.
