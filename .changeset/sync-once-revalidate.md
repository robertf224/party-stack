---
"@party-stack/ontology-replica": patch
"@party-stack/ontology-server": patch
---

`server.syncOnce(target, { revalidate: true })` (and `replica.revalidate`) reloads
every demanded subset, including subsets a healthy realtime watch reports as current.
Use it for a refresh the user asks for, such as pull to refresh. Rows stay visible
while they reload.
