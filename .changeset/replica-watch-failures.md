---
"@party-stack/ontology-replica": patch
---

A subset watch that fails before opening or before delivering any change no
longer invalidates its object type's coverage or forces a snapshot reload. The
demand is marked unmaintained and revalidates by coverage age; successful
re-acquisitions still repair the gap. Non-retryable watch failures fall back to
the route's configured poll interval, or to age-based revalidation, instead of
retrying.
