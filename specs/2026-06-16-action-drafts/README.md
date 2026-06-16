# Action Drafts

## Summary

Action drafts are a proposed userspace ergonomics layer for building and retaining pending ontology action parameters before an action is submitted. They should make product code feel like it is working with a durable form/draft, while still using the existing live ontology, blob manager, and adapter boundaries underneath.

The main motivation is attachment-heavy workflows. Plain `ontology.attachments.create()` can stay target-optional and provider-agnostic: it stages local bytes and returns an attachment value. A draft layer can add the missing product ergonomics by knowing which action is being edited, deriving attachment targets from action parameters when possible, and exposing draft-scoped blob retention.

This spec is intentionally about action drafts generally, not a new core attachment API. Drafts should compose with live ontology instead of replacing it.

## Background

The attachment redesign landed on a few constraints that shape this design:

- Attachment creation should work without knowing the final action or object property. This keeps the lowest-level API useful across providers.
- Some providers need target metadata for upload routing. Foundry, for example, may need the resolved `AttachmentTypeDef` to distinguish attachment/media behavior.
- The live ontology layer can resolve action parameters and collect attachment uploads before `applyAction`, so action parameters are often enough to provide provider routing information.
- Eager attachment materialization should be allowed to start in the background, with action submission acting as the correctness barrier.
- Blob GC should be driven by retention providers, not by public `lease()` APIs in core. Draft state is a natural source of retained attachment ids.
- Complex providers like Outlook may materialize attachments inside action-specific logic, such as an `addMessageAttachment` action that creates an upload session and attaches bytes directly to a message.

## Goals

- Let product code bind form state to an ontology action before submitting it.
- Make draft-scoped attachment creation ergonomic, including automatic target inference when the action parameter is unambiguous.
- Retain staged blobs while a draft still references them.
- Keep the draft layer optional and replaceable by app-specific durable state, offline transaction queues, or future libraries.
- Preserve the current adapter boundary: adapters receive resolved action parameters and attachment uploads; they do not need to know about draft UI state.

## Non-Goals

- Do not add a required draft system to core live ontology in this pass.
- Do not make blob storage depend on TanStack DB or any particular durable-state library.
- Do not require all providers to support eager materialization.
- Do not model arbitrary upload-session state yet. Action-owned provider logic can handle that until a repeated pattern emerges.

## Proposed API Sketch

A React-oriented draft layer could look like this:

```tsx
function NewTaskForm() {
    const draft = useDraftAction(ontology.actions.createTask, {
        initialParameters: {
            title: "",
            attachments: [],
        },
    });

    async function addImage(file: File) {
        const { attachment, isMaterialized } = await draft.attachments.create(file, {
            parameter: "attachments",
            eager: true,
        });

        draft.set("attachments", [...draft.parameters.attachments, attachment]);
        void isMaterialized?.catch(() => {
            draft.setAttachmentStatus(attachment.id, "failed");
        });
    }

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                void draft.submit();
            }}
        >
            {/* form fields */}
        </form>
    );
}
```

The important behavior is that `draft.attachments.create()` can infer the ontology target from the action parameter. Product code does not need to spell `{ kind: "actionParameter", actionType, parameter }` in the common case.

For actions with exactly one attachment-capable parameter, the parameter could be optional:

```ts
const { attachment } = await draft.attachments.create(file);
```

If there are multiple candidate parameters, the draft helper should require the caller to specify one rather than guessing.

## Draft Object Shape

A draft action helper might expose:

```ts
interface ActionDraft<Parameters> {
    parameters: Parameters;
    set<Key extends keyof Parameters>(key: Key, value: Parameters[Key]): void;
    update(update: Partial<Parameters>): void;
    submit(): Promise<void>;
    reset(): void;
    attachments: DraftAttachments;
    retentionProvider: () => Iterable<string>;
}

interface DraftAttachments {
    create(
        blob: Blob | File,
        opts?: {
            parameter?: string;
            eager?: boolean;
        }
    ): Promise<{
        attachment: attachment;
        isMaterialized?: Promise<void>;
    }>;
}
```

The draft owns parameter state, not persisted ontology objects. Calling `submit()` runs the live ontology action with the current draft parameters.

## Attachment Target Inference

Draft attachment creation can resolve targets in this order:

1. If the caller specifies `parameter`, resolve that action parameter to an attachment type and pass the corresponding action-parameter target to `ontology.attachments.create()`.
2. If the action has exactly one attachment-capable parameter, infer it.
3. If no parameter can be inferred, call `ontology.attachments.create()` without a target.
4. If multiple parameters are possible and no parameter was supplied, throw a product-facing error.

Nested structures should still use the parameter-level target for provider routing. The live ontology preparation step already walks lists, maps, optionals, and structs to collect concrete attachment values for action submission.

## Retention

Drafts should retain any staged attachments referenced by their current parameter state. This can be implemented as a `BlobRetentionProvider`:

```ts
const retentionProvider = () => collectAttachmentIds(draft.parameters);
```

An app-level draft registry could combine active draft retention providers and pass them into the blob manager/store setup. This keeps GC natural without reintroducing public blob leases.

Durable drafts can use any persistence layer. For example, an app might store draft parameters in local storage, IndexedDB, TanStack DB, or a custom offline queue. The blob layer only needs retained ids; it does not need to understand the draft storage implementation.

## Submit Behavior

`draft.submit()` should:

1. Snapshot current draft parameters.
2. Execute the live ontology action.
3. Let live ontology prepare action parameters, collect attachment uploads, and await/materialize uploads as needed.
4. Let the adapter apply the action.
5. Let live ontology record any returned attachment id mappings.
6. Clear or archive the draft once the action is accepted by the chosen product semantics.

For providers that upload as part of `applyAction`, the draft layer should not need special provider code. It only supplies the action parameters and keeps referenced blobs retained until the action is no longer pending.

## Open Questions

- Where should a reusable React implementation live: an `ontology-react` package, an app-local helper, or a separate drafts package?
- How durable should default drafts be? A hook-only implementation is simple, but durable drafts likely need storage decisions from the host app.
- Should draft attachment status be derived only from returned `isMaterialized` promises, or should the blob layer eventually expose persisted upload state subscriptions?
- Should draft submission integrate with offline transaction queues, or should offline queues simply act as another retention provider?
- Do we need first-class provider upload session metadata later, or is action-owned adapter state enough for now?
