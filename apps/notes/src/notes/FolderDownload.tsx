import { useOntology } from "@party-stack/ontology-react";
import { eq } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { Suspense, useState } from "react";
import { downloadFolder } from "./downloadFolder";
import { DownloadStatus, downloadState } from "./DownloadStatus";
import { IconButton, textError } from "./ui";

function FolderDownloadControl({ folderId }: { folderId: string }) {
    const ontology = useOntology();
    const downloads = ontology.pins(downloadFolder);
    const { data: pin } = useLiveSuspenseQuery((q) =>
        q
            .from({ pin: downloads.collection })
            .where(({ pin }) => eq(pin.inputs.folderId, folderId))
            .findOne()
    );
    const [failure, setFailure] = useState<string>();
    const status = downloadState(pin);
    const label =
        status === "ready"
            ? "Remove folder download"
            : status === "downloading"
              ? "Cancel folder download"
              : status === "failed"
                ? "Retry folder download"
                : "Download folder";
    return (
        <span className="folder-download" data-status={status}>
            <IconButton
                label={label}
                aria-pressed={Boolean(pin)}
                title={
                    failure ??
                    pin?.error?.message ??
                    (status === "ready" ? "Available offline, including attachments" : label)
                }
                onClick={() => {
                    setFailure(undefined);
                    void (
                        status === "ready" || status === "downloading"
                            ? downloads.remove({ folderId })
                            : downloads.set({ folderId })
                    ).catch((error) => setFailure(textError(error)));
                }}
            >
                <DownloadStatus status={status} />
            </IconButton>
            {failure && (
                <span className="sr-only" role="alert">
                    {failure}
                </span>
            )}
        </span>
    );
}
export function FolderDownload({ folderId }: { folderId: string }) {
    return (
        <Suspense
            fallback={
                <IconButton label="Loading download status" disabled>
                    <DownloadStatus status="off" />
                </IconButton>
            }
        >
            <FolderDownloadControl key={folderId} folderId={folderId} />
        </Suspense>
    );
}
