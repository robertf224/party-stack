---
"@party-stack/better-auth": patch
"@party-stack/blobs": patch
"@party-stack/build-config": patch
"@party-stack/connections": patch
"@party-stack/coordination": patch
"@party-stack/db-indexeddb-persistence": patch
"@party-stack/durable-object-ontology": patch
"@party-stack/errors": patch
"@party-stack/expo-runtime": patch
"@party-stack/foundry-client": patch
"@party-stack/foundry-object-set-watcher": patch
"@party-stack/foundry-ontology": patch
"@party-stack/icons": patch
"@party-stack/icons-blueprint": patch
"@party-stack/icons-expo": patch
"@party-stack/icons-lucide": patch
"@party-stack/icons-salesforce-lightning": patch
"@party-stack/node-runtime": patch
"@party-stack/oauth": patch
"@party-stack/ontology": patch
"@party-stack/ontology-devtools": patch
"@party-stack/remote-ontology": patch
"@party-stack/runtime": patch
"@party-stack/salesforce-client": patch
"@party-stack/salesforce-ontology": patch
"@party-stack/sqlite-ontology": patch
"@party-stack/tanstack-start-build-config": patch
"@party-stack/web-runtime": patch
"@bobbyfidz/apollo": patch
"@bobbyfidz/foundry-graphql": patch
"@bobbyfidz/foundry-graphql-schema": patch
"@bobbyfidz/osdk-react": patch
"@bobbyfidz/osdk-utils": patch
---

Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.
