---
"@party-stack/ontology-replica": patch
---

A complete limited load that returns fewer rows than its limit now also proves its whole filter, so follow-up reads of the same filter (rows tied with the window's last row, or rows after a cursor) are answered locally instead of fetched again.
