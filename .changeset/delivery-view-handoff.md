---
"@party-stack/ontology-replica": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology-server": minor
---

Change a child replica's view on its open delivery subscription instead of replacing the subscription. `OntologySource.updateView` (the `UpdateView` RPC over ontology-server) sends the new view; the parent acquires demand for added subsets before releasing removed ones, and the same stream delivers the difference, so loads both views select keep running. In a browser tab whose search box changed the view on every keystroke, each change had cancelled and restarted every search still selected. Sources without `updateView`, including older servers, keep the previous behavior of subscribing again.

`demand.idleRetentionMs` now defaults to 5 seconds for live replicas (0 for one-shot ones), so a released subset's watch and in-flight load survive a consumer that comes straight back, such as a remount or a view replaced by subscribing again.
