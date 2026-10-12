export type FoundryAttachmentKind = "attachment" | "media";

export function foundryAttachmentMeta(kind: FoundryAttachmentKind): Record<string, unknown> {
    return { foundry: { kind } };
}

export function getFoundryAttachmentKind(meta: Record<string, unknown> | undefined): FoundryAttachmentKind {
    const foundry = meta?.foundry;
    if (typeof foundry === "object" && foundry !== null && !Array.isArray(foundry)) {
        const kind = (foundry as Record<string, unknown>).kind;
        if (kind === "attachment" || kind === "media") {
            return kind;
        }
    }
    return "attachment";
}
