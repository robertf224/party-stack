---
"@party-stack/foundry-object-set-watcher": patch
---

Keep Foundry's subscription error and closure payloads on state messages as a
`reason` (error names in `message`, the raw payload in `detail`). New consumers
no longer receive a `closed` or `qos` state left over from an earlier connection,
which made fresh watches fail immediately. Consumers joining a subscription that
Foundry rejected receive that error without resending every subscription; the
object set is retried once all of its consumers have left.
