import type { BlobDimensions } from "@party-stack/blobs";
import type { ImageMediaType as GeneratedImageMediaType } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";

type AttachmentMetadataValues<Type extends string> = {
    size: number;
    type: Type;
    name?: string;
    dimensions: BlobDimensions;
};

export type AttachmentMetadataField<Type extends string = string> =
    | Exclude<keyof AttachmentMetadataValues<Type>, "dimensions">
    | ([Type] extends [GeneratedImageMediaType] ? "dimensions" : never);

export type AttachmentMetadataSelection<Type extends string = string> = ReadonlyArray<
    AttachmentMetadataField<Type>
>;

export type PartialAttachmentMetadata<Type extends string = string> = Partial<AttachmentMetadataValues<Type>>;

export type AttachmentMetadata<
    Type extends string = string,
    Selected extends AttachmentMetadataField<Type> = "size" | "type" | "name",
> = attachment<Type> & Pick<AttachmentMetadataValues<Type>, Selected>;
