export interface AttachmentMetadata {
    type?: string;
    size?: number;
    filename?: string;
}

export interface AttachmentValue<Id extends string = string> {
    id: Id;
    metadata: () => Promise<AttachmentMetadata>;
    blob: () => Promise<Blob>;
}

export interface ResolvedAttachment<Id extends string = string> {
    id: Id;
    metadata: AttachmentMetadata;
    blob: Blob;
}

export async function resolveAttachment<Id extends string = string>(
    attachment: AttachmentValue<Id>
): Promise<ResolvedAttachment<Id>> {
    const [metadata, blob] = await Promise.all([attachment.metadata(), attachment.blob()]);
    return {
        id: attachment.id,
        metadata,
        blob,
    };
}

//

// AttachmentStorageAdapter
// save (blob, id) => promise<blob>
// get (id) => promise<blob>
// ...

// effect
