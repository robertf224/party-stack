---
"@party-stack/ontology-spec": minor
"@party-stack/ontology": minor
---

Extract the complete ontology specification, pure helpers, JSON codecs, and code
generation into ontology-spec, while preserving existing ontology public imports.
Keep live collections, installations, metadata pulling, and backend integration
in ontology. Support standalone model generation without live factories and
retain the explicit self-hosted IR bootstrap.

Add opt-in Effect v4 model/schema generation using the same ontology definitions.
Generated codecs bridge portable models and Effect Result values, with Temporal
ISO codecs and no Effect runtime dependency in ordinary spec imports.

Compile the same Effect codec registries directly from runtime ontology IR,
without generated source or evaluation, for dynamically installed definitions.
