---
"@party-stack/connect": patch
---

`connectionAccessToken` now waits for another caller's in-flight refresh and re-reads the token instead of failing with `Conflict` ("Connection operation is in progress.") when parallel requests find an expiring access token.
