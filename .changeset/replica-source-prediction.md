---
"@party-stack/ontology-replica": patch
---

`outbox.prediction: "source"` makes a child replica forward actions without resolving
or predicting them. Its parent resolves parameter defaults, predicts against its own
data and replicates the result back, honoring the requested visibility. Use it for an
embedded child, such as a form WebView, that holds only the rows it displays.
