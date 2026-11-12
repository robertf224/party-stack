---
"@party-stack/ontology-storage": patch
"@party-stack/ontology-spec": patch
"@party-stack/ontology-replica": patch
"@party-stack/ontology-server": patch
---

Speed up opening large definitions, especially on mobile JavaScript engines.

- Cache definition signatures, definition hashes and compiled Effect codecs per
  definition object. Opening one route previously recomputed them for the server,
  replica, policy and every view. Definitions must not be mutated after use.
- Decode persisted values with a single-pass validating decoder instead of a
  recursive Schema union. The accepted version-2 format is unchanged.
- Same-runtime local clients share the server's validated description, and
  serialized clients no longer re-encode and decode a Describe response that the
  RPC client already decoded. Caller-retained descriptions are still copied.
- The replica partition catalog reuses decoded records and skips rewriting an
  unchanged retained definition when a route reopens.

A local benchmark opening a 74-object-type, 189-action Foundry definition through
`localClient` dropped from about 420 ms to 230 ms for the first view, 437 ms to
190 ms after a restart, and 184 ms to 40 ms for an additional view.
