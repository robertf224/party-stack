import { Attachment } from "@osdk/api";
import { PalantirApiError } from "@osdk/client";
import { Attachments } from "@osdk/foundry.ontologies";
import { useSuspenseQuery, UseSuspenseQueryResult } from "@tanstack/react-query";
import { useOsdkContext } from "../OsdkContext";
import { blobToDataUrl } from "../utils";

export function useAttachment(
    attachment: Attachment | string | undefined
): UseSuspenseQueryResult<string | null> {
    const { client } = useOsdkContext();
    const rid = typeof attachment === "string" ? attachment : attachment?.rid;
    return useSuspenseQuery({
        queryKey: ["osdk", "attachment", rid],
        queryFn: async () => {
            if (rid === undefined) {
                return null;
            }
            try {
                const contents = await Attachments.read(client, rid);
                const blob = await contents.blob();
                return blobToDataUrl(blob);
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
