# Recovery, server composition, and validation checkpoint

Agreed October 26, 2026. This is the implementation checklist for the complete
checkpoint, not only the error-contract change. Unchecked items remain work.

- [x] Shared normalized errors in ontology-backend; retire the errors package.
- [x] Shared wire error with hook error aliases, structured ValidationFailed issues, Effect-native
      validateAction and validateActionDraft, preserving uncertain draft reports.
- [x] Foundry constraint/reference/custom-message normalization; Salesforce and
      protocol authentication, throttling, validation, and unknown-outcome handling.
- [x] Forward/projected error policies using exposed action definitions; safe
      errors in responses and replicated action state; no raw causes on the wire.
- [x] Concrete session/history/view/result recovery without replacing the runtime
      or losing pending work. Reconnect transport in the existing scoped lifecycle.
- [x] Separate configurable result, journal, and idle-session retention, including
      indexed bounded cleanup. Paused pending actions do not expire.
- [x] Cached proxy composition: shared subset demand, stateless authorized reads,
      upstream write forwarding without accepting into a proxy outbox. HTTP/RPC
      callers need no replication client registry entry for these operations.
- [x] Reuse row/property/action/context authorization projection on the new server
      path. Stateless access remains distinct from privileged replica inspection.
- [x] Finish Effect-owned validation/lifecycle boundaries; remove the unused
      adapter live flag while retaining explicit provider watch configuration.
- [x] Redacted at concrete credential/diagnostic boundaries, without changing the
      portable ontology Encrypted representation or encrypting outbox inputs.
- [x] Appropriate recovery/provider/projection regression tests, full CI, and
      issue-tracker acceptance. Keep the example dev server available.

Already completed: standalone provider collection helper retirement. Deferred:
full hierarchical query watching/IVM, retained replica-state deltas, advertised or
versioned idempotency windows, general schema migrations, and outbox encryption.

Server construction uses `kind: "owned" | "proxy" | "replica"`. A proxy can add a
confirmed read cache; it never accepts writes into that cache's outbox. There is no
writes flag: authorization decides whether Invoke/Submit are exposed. A replica
server exposes composed state through its own selected-state protocol, never by
mislabeling the upstream authoritative journal as its optimistic change stream.

Verification: full workspace CI passed 130/130 tasks; issue-tracker browser acceptance
passed 4/4 cases through native RPC, including offline writes, initiating-tab closure,
shared-owner reconciliation, single-process fallback, navigation and attribution.
Retention starvation regressions and documentation are included in CI. Live
Foundry/Salesforce provider acceptance is separate.

Known follow-up: TanStack can log dependent-query cleanup warnings during pagehide
while React consumers are still mounted. Scoped resources close and browser recovery
passes; review UI unmount versus DbClient disposal order separately. This checkpoint
does not claim general protocol-child GC or untrusted replica-state authorization.
