# Error taxonomy and recovery audit — October 28, 2026

This audit accompanies incremental delivery. The original `ValidationFailed`
category was also being used for malformed replication rows, invalid policies,
query syntax, protocol envelopes and invalid decrypted output. Consumers could
not distinguish a field error from an infrastructure fault.

## Failure facts

`BackendError` remains the shared schema-backed, yieldable Effect error. Its
`kind` is the stable machine-readable discriminator; messages are presentation.
`ReplicationError` names the subset of kinds specific to replication control.
There is no second conflicting wire format or HTTP-only error taxonomy.

| Category                                   | Meaning                                                                                               | Typical consumer                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ValidationFailed`                         | Action or query-function parameters/constraints failed                                                | Form/action UI; projected field issues    |
| `InvalidRequest`                           | Invalid query, byte range, handle, request envelope, sequence format or API usage                     | Caller fixes request                      |
| `InvalidResponse`                          | Invalid upstream row, receipt, decrypted result or decoded RPC response                               | Reject data, report source/protocol fault |
| `InvalidConfiguration`                     | Invalid schema, retention, timeout or capacity configuration                                          | Application setup/operator                |
| `Unauthenticated`, `Forbidden`, `NotFound` | Authentication, authorization and resource visibility                                                 | Connection/application policy             |
| `Conflict`                                 | A valid operation conflicts with existing state/identity                                              | Resolve the conflicting state             |
| `NotImplemented`                           | Capability unavailable                                                                                | Choose another supported operation        |
| `RateLimited`, `Unavailable`               | Capacity or availability failure                                                                      | Backoff according to retry facts          |
| `Internal`                                 | Broken local invariants, invalid custom implementation output, unexpected defects at the RPC boundary | Diagnostics/operator                      |

Configuration errors are detected when constructing scoped services. An HTTP
binding can still represent one if server configuration fails while serving a
request. Provider HTTP 400 is `InvalidRequest`; recognized provider constraint
failures remain `ValidationFailed`. Foundry decrypt now preserves 401, 403 and
429 as `Unauthenticated`, `Forbidden` and `RateLimited`.

Storage has its own lower-level typed reasons. The backend boundary preserves
query/configuration/schema/uniqueness classifications instead of making every
storage failure a retryable network outage. Invalid schema/codec output from a
custom local implementation is an internal fault. Incoming row identity checks
use `InvalidResponse`.

HTTP status mapping is shared: 400 request, 422 domain validation, 502 invalid
upstream response, 500 configuration/internal, 401/403/404, 429, 503 and 409 for
conflicting replication state. The typed kind survives RPC and legacy HTTP.
HTTP status alone does not select a replication recovery action.

## Replication recovery

`deliveryRecovery` is a controller policy, computed from the typed failure.
Recovery cancels/reopens the acquisition/delivery Scope. It retains the Replica,
local outbox, demand, storage and connection resources.

| Failure                                       | Handling                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ViewReplaced`                                | Immediately acquire the current selection                                                 |
| `HistoryExpired`                              | Acquire a fresh selected snapshot                                                         |
| `SessionExpired`, `SessionReplaced`           | Renew/reconcile the child session, then reacquire                                         |
| Retryable transport/unavailability/rate limit | Reconnect with backoff                                                                    |
| `ResultExpired`                               | Stop automatic delivery recovery; unresolved action evidence needs reconciliation         |
| `SourceMismatch`, `SchemaMismatch`            | Stop; explicit reset/migration required                                                   |
| `InvalidResponse`, `InvalidConfiguration`     | Stop and expose diagnostics; repeated invalid data is not repaired by infinite reconnects |

A gap between frames/positions is recoverable history loss. A row with a primary
key different from its transmitted key is invalid data. Those are different
conditions. No partial batch is installed for either failure.

Action outcome remains an independent fact: an invalid/lost action response can
mean a write happened. `actionOutcome: "unknown"` prevents treating a bad reply as
a safe rejection. Recovery cannot discard or resubmit an action merely because
a read stream restarted. Known domain rejections carry `not-committed`.

## Effect behavior

`Schema.TaggedError` values implement Effect's yieldable error interface:

```ts
const install = Effect.gen(function* () {
    return yield* new BackendError({
        operation: "replica.install",
        kind: "InvalidResponse",
        message: "Incoming row key does not match its primary key.",
        retryable: false,
    });
});
// Equivalent failure channel behavior:
const failed = Effect.fail(error);
```

The inferred error of `putIncomingRow` is
`BackendError<"InvalidResponse"> | OntologyStorageError`. A compile-time assertion
and runtime `Effect.result` / `Effect.catchTag("BackendError", ...)` test guard this.
Throwing from a generator instead produces a defect; transport boundaries sanitize
unexpected defects to `Internal`. Native Effect RPC decoding failures retain the
`InvalidResponse` distinction from ordinary transport failures.

Validation issues are exposed only for `ValidationFailed`. Error projection
strips raw causes and applies the existing allowed-parameter/category rules;
configuration and protocol faults cannot accidentally become field errors.

## References and lessons

- [Effect's installed RPC error source](../../../node_modules/effect/src/rpc/RpcClientError.ts): declared remote errors are distinct from client transport/decoding failures.
- [Effect's installed HTTP error source](../../../node_modules/effect/src/http/HttpClientError.ts): a common error wrapper contains specific typed reasons.
- [OpenCode AI error model](https://github.com/anomalyco/opencode/blob/dev/packages/ai/src/schema/errors.ts): separate request, provider-output, configuration and transport failures; transport records can carry delivery and recovery facts.
- [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html): coarse response status semantics.
- [HTTP problem details, RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html): machine-readable domain detail supplements coarse statuses.

Future work: per-ontology action error/issue inference, explicit controller error
status in the inspector, and tighter per-hook error unions as the query/protocol
contracts settle. No new generic retry middleware or automatic namespace reset.
