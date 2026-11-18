---
"@party-stack/foundry-ontology": patch
---

Submission criteria and OMS action metadata loads now reach Foundry's ontology metadata service through the client's own `fetch`. conjure-lite ignores `fetch`, so a client whose credentials live in it, such as an authenticated-egress or SharedWorker connection client, used to send the submission-criteria request anonymously. The context also passed that client's rejecting `tokenProvider`. Both call sites now share one context: `fetchFn` only, on the Foundry origin.
