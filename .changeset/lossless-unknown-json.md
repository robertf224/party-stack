---
"@party-stack/ontology-spec": minor
---

The JSON codec keeps dates and timestamps typed in `unknown` positions. They encode as `{"$type": "date" | "timestamp", "value": "<ISO 8601>"}`; every other value, plain strings included, encodes exactly as before, and existing JSON reads back unchanged. `$type` is reserved in `unknown` values, and decoding accepts it for any scalar kind (`string`, `boolean`, `integer`, `float`, `double`, `date`, `timestamp`). Typed positions are unchanged. `encodeUnknown` and `decodeUnknown` apply the same rule to values with no IR target, such as a stored query document. Query literals holding `Temporal.Instant` or `Temporal.PlainDate` now type as timestamp or date, so they compare with timestamp and date properties.
