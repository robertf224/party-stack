import { Attachments } from "@osdk/foundry.ontologies";
import { useMutation, UseMutationResult } from "@tanstack/react-query";
import { UseMutationOptions } from "@tanstack/react-query";
import { useOsdkContext } from "../OsdkContext";
import { AttachmentMetadata } from "./useAttachmentMetadata";

export function useUploadAttachment(
    mutationOpts?: Omit<
        UseMutationOptions<AttachmentMetadata, Error, { file: File }>,
        "mutationFn" | "mutationKey"
    >
): UseMutationResult<AttachmentMetadata, Error, { file: File }> {
    const { client } = useOsdkContext();
    return useMutation({
        ...mutationOpts,
        mutationFn: async ({ file }) => {
            const attachment = await Attachments.upload(client, file, { filename: file.name });
            return {
                ...attachment,
                sizeBytes: Number(attachment.sizeBytes),
            };
        },
    });
}
