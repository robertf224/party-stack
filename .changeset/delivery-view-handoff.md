---
"@party-stack/ontology-replica": patch
---

Keep loads running when a child replica changes its view. A delivery subscription now holds its selection's demand for 5 seconds after it ends, so the subscription that replaces it (a new view, or a reconnect) reuses every load the two share instead of cancelling and restarting them. In a browser tab whose search box changed the view on every keystroke, each change had restarted every search still selected.
