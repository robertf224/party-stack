import { CircleAlert, CircleCheck, Download, LoaderCircle } from "lucide-react";

export type DownloadState = "off" | "downloading" | "ready" | "failed";
export function downloadState(pin?: { ready?: boolean; error?: unknown }): DownloadState {
    return !pin ? "off" : pin.error ? "failed" : pin.ready ? "ready" : "downloading";
}

export function DownloadStatus({ status, compact = false }: { status: DownloadState; compact?: boolean }) {
    const label =
        status === "ready"
            ? "Available offline"
            : status === "downloading"
              ? "Downloading"
              : status === "failed"
                ? "Download interrupted"
                : "Not downloaded";
    return (
        <span
            className={`folder-download-icon${compact ? " compact" : ""}`}
            data-status={status}
            role={compact ? "img" : undefined}
            aria-label={compact ? label : undefined}
            aria-hidden={compact ? undefined : true}
            title={compact ? label : undefined}
        >
            <span data-visible={status === "off"}>
                <Download size={19} />
            </span>
            <span data-visible={status === "downloading"}>
                <LoaderCircle size={19} className="download-spinner" />
            </span>
            <span data-visible={status === "ready"}>
                <CircleCheck size={19} />
            </span>
            <span data-visible={status === "failed"}>
                <CircleAlert size={19} />
            </span>
        </span>
    );
}
