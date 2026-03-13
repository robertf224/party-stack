import { Attachment } from "@osdk/api";
import { PalantirApiError } from "@osdk/client";
import { Attachments } from "@osdk/foundry.ontologies";
import { useSuspenseQuery, UseSuspenseQueryResult } from "@tanstack/react-query";
import { useOsdkContext } from "../OsdkContext";

export interface AttachmentMetadata {
    rid: string;
    filename: string;
    sizeBytes: number;
    mediaType: string;
}

export function useAttachmentMetadata(
    attachment: Attachment | string | undefined
): UseSuspenseQueryResult<AttachmentMetadata | null> {
    const { client } = useOsdkContext();
    const rid = typeof attachment === "string" ? attachment : attachment?.rid;
    return useSuspenseQuery({
        queryKey: ["osdk", "attachment-metadata", rid],
        queryFn: async (): Promise<AttachmentMetadata | null> => {
            if (rid === undefined) {
                return null;
            }
            try {
                const attachment = await Attachments.get(client, rid);
                return {
                    ...attachment,
                    sizeBytes: Number(attachment.sizeBytes),
                };
            } catch (error) {
                if (error instanceof PalantirApiError && error.errorName === "AttachmentNotFound") {
                    return null;
                }
                throw error;
            }
        },
        staleTime: Infinity,
        initialData: rid ? undefined : null,
    });
}
