# Foundry media support

## Status

The ontology and blob layers support:

- attachment media-type, size, and image-dimension constraints;
- selected metadata reads with provider pushdown and local fallback;
- direct Media Sets reads and detailed image metadata for complete Foundry media IDs;
- legacy temporary media uploads with local-to-remote ID binding.

Datasource-driven routing and predicted media IDs remain future work. Begin that work when Foundry object type datasources return `mediaSetRid` in addition to `mediaSetViewRid`.

## Goals

1. Derive ontology attachment constraints from the schema of each property's backing media set.
2. Apply the same constraints to action parameters that write those properties.
3. Predict stable Foundry media IDs before upload.
4. Support eager and action-time uploads without replacing local IDs after the upload.
5. Preserve compatibility with legacy/tokenized media references.

## Datasource discovery

Load object types with datasources in addition to the existing full ontology metadata. If the API begins returning the field before the SDK publishes it, locally augment its type:

```ts
type MediaSetViewDatasourceWithSetRid = ObjectTypeMediaSetViewDatasource & {
    mediaSetRid: MediaSetRid;
};
```

Build a lookup keyed by object type and property API name:

```ts
Map<
    ObjectTypeApiName,
    Map<
        PropertyApiName,
        {
            mediaSetRid: MediaSetRid;
            mediaSetViewRid: MediaSetViewRid;
        }
    >
>;
```

Reject or explicitly disambiguate conflicting media-set datasources for the same property. Do not silently select one.

## Constraint derivation

For each routed media-reference property:

1. Follow `mediaSetRid` through the Media Sets get endpoint.
2. Read the media set's schema.
3. Convert supported schema information into `AttachmentTypeDef.constraint`.
4. Preserve `mediaSetRid` and `mediaSetViewRid` under adapter-private `AttachmentTypeDef.meta`.

Initial schema mapping:

- `IMAGERY` becomes the image content variant.
- Allowed Foundry imagery formats become `ImageMediaType` options.
- Size or dimension limits are emitted only when the media set schema exposes authoritative limits.
- Unsupported or multimodal schemas remain unconstrained rather than inferred from observed objects.

The ontology image media-type enum currently mirrors Foundry imagery decode support: BMP, TIFF, NITF, JPEG 2000, JPEG, PNG, and WebP.

Until Foundry exposes enough datasource schema metadata, applications can supply targeted attachment constraints through `FoundryOntologyPullConfig.options.attachmentConstraints`. These are applied after every pull, so generated ontology files remain disposable.

### Action parameters

Action parameters that write routed media properties must receive the same attachment definition as the target property.

Derive this by following action logic/property assignments:

1. Resolve the target object type and property.
2. Look up that property's media-set route and derived attachment constraint.
3. Apply the constraint and adapter-private routing metadata to the corresponding attachment parameter.
4. Verify that one parameter is not assigned to properties with incompatible media-set schemas.

Property and action-parameter conversion should share one constraint-conversion function so they cannot drift.

## Metadata reads

For IDs that decode as `FoundryMediaId`:

1. Use the inline media-reference MIME type to satisfy `type` without a request.
2. Use [Get Media Item Metadata](https://www.palantir.com/docs/foundry/api/v2/media-sets-v2-resources/media-sets/get-media-item-metadata/) when `dimensions` are selected.
3. Cache every intrinsic field returned by Foundry, including unselected fields such as `size`.
4. Read bytes directly with `mediaSetRid` and `mediaItemRid`.

Keep `MediaReferenceProperties` as a compatibility fallback for references that cannot be decoded into a complete media-set ID or still require an object-property source/read token.

## Predicted media IDs

Once a target includes `mediaSetRid` and `mediaSetViewRid`, generate the final media ID before staging:

1. Generate a client-side `MediaItemRid`.
2. Combine it with the known media set and view RIDs.
3. Encode the three RIDs with `encodeFoundryMediaId`.
4. Stage bytes under that final ID.

The Media Sets upload endpoint accepts a caller-provided `mediaItemRid`, allowing upload to use the predicted ID:

```ts
await MediaSets.upload(client, mediaSetRid, blob, {
    mediaItemRid,
    viewRid: mediaSetViewRid,
    mediaItemPath,
});
```

Verify that the returned `mediaItemRid` and `mediaSetViewRid` match the prediction.

### Transaction policy

Cache the media set's transaction policy with its routing metadata:

- For no-transaction media sets, upload directly.
- For batch-transaction media sets, create a transaction, upload with the predicted item RID, and commit.
- Abort failed transactions.
- Make retries idempotent by probing the predicted item RID before retrying an uncertain upload.

### Eager materialization

Enable eager materialization when the attachment target contains a complete route:

- `generateAttachmentId` returns the predicted encoded Foundry media ID.
- `canMaterializeAttachment` returns true.
- `materializeAttachment` uploads to the known media set using the predicted item RID.
- The staged and remote IDs remain identical.

### Action-time materialization

When eager materialization is disabled:

1. Keep the predicted ID on the optimistic attachment value.
2. Upload staged bytes to the routed media set before applying the action.
3. Encode the action parameter from the same predicted ID and MIME type.
4. Do not emit an attachment ID mapping.

This removes the optimistic local-ID to confirmed remote-ID transition and avoids preview remount/flicker.

## Compatibility fallback

If a target lacks `mediaSetRid`:

- retain the current temporary `MediaSets.uploadMedia` flow;
- continue returning local-to-remote attachment ID mappings;
- bind the remote ID in the blob manager;
- keep object-property source information for legacy reads.

Remove this fallback only after all supported Foundry deployments expose complete media-set routing.

## Rollout

1. Add SDK type augmentation and datasource parsing tests.
2. Add media-set schema conversion tests.
3. Enrich object properties and action parameters.
4. Add predicted ID generation without changing upload behavior.
5. Implement routed action-time upload.
6. Implement eager routed upload and transaction handling.
7. Exercise both routed and fallback paths in the issue tracker.

## Completion criteria

- Routed media properties expose constraints derived from their backing media set schema.
- Corresponding action parameters expose identical constraints and routing metadata.
- Selected dimensions use Foundry metadata without downloading bytes when available.
- Routed eager and action-time uploads retain one stable ID from creation through confirmation.
- Routed media uploads require no blob-manager remote ID binding.
- Legacy attachments and unrouted/tokenized media references continue to work.
