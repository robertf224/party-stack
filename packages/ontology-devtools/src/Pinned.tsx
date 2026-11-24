import { PartyStackLogomark } from "@party-stack/design-system/brand";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { CircleAlert, CircleCheck, LoaderCircle, Paperclip, Pin } from "lucide-react";
import { Suspense } from "react";
import { DisclosureSummary } from "./DisclosureSummary.js";
import { PinnedFamily, groupPinDownloads } from "./PinnedFamily.js";
import { QueryDocumentView, QueryExpression } from "./QueryView.js";
import type { LiveOntology, OntologyIR, QueryDocument } from "@party-stack/ontology";

/** One download's definition and readiness, as the inspector shows it. */
export interface DownloadStatus {
    readonly query: QueryDocument;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly attachments: "none" | "all";
    readonly ready: boolean;
    readonly error?: { readonly kind: string; readonly message: string };
}

export function Pinned({ ontology }: { ontology: LiveOntology }) {
    return (
        <div className="ps-pinned-inventory">
            <Suspense fallback={<PinnedContent ir={ontology.ir} loading />}>
                <PinInventory ontology={ontology} />
            </Suspense>
        </div>
    );
}

function PinInventory({ ontology }: { ontology: LiveOntology }) {
    const { pins } = ontology;
    const { data: downloads } = useLiveSuspenseQuery((q) =>
        q
            .from({ pin: pins.collection })
            .orderBy(({ pin }) => pin.name, "asc")
            .orderBy(({ pin }) => pin.id, "asc")
    );
    if (!downloads.length) return <PinnedContent ir={ontology.ir} />;
    return (
        <>
            {groupPinDownloads(downloads).map((family) => (
                <PinnedFamily
                    key={family.name}
                    family={family}
                    ir={ontology.ir}
                    remove={ontology.pins.remove}
                />
            ))}
        </>
    );
}

export function PinnedContent({
    ir,
    status,
    loading = false,
    error,
    title = "Pinned graph",
}: {
    ir: OntologyIR;
    status?: DownloadStatus;
    loading?: boolean;
    error?: unknown;
    title?: string;
}) {
    if (loading)
        return (
            <div className="ps-pinned-empty">
                <output aria-label="Reading pinned graph">
                    <span className="ps-pinned-logo">
                        <PartyStackLogomark />
                    </span>
                </output>
            </div>
        );
    const failure =
        error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : error
                ? "Could not read the pinned graph."
                : status?.error?.message;
    if (!status)
        return (
            <div className="ps-pinned-empty">
                <Pin size={24} aria-hidden />
                <p role={failure ? "alert" : undefined}>{failure ?? "No pinned graph."}</p>
            </div>
        );
    const state = failure ? "error" : status.ready ? "ready" : "loading";
    const Icon = failure ? CircleAlert : status.ready ? CircleCheck : LoaderCircle;
    return (
        <div className="ps-diagnostics-screen ps-pinned-screen" aria-label="Pinned inspector">
            <header className="ps-pinned-header">
                <div>
                    <h2>{title}</h2>
                    <div className="ps-pinned-meta">
                        <output className="ps-pinned-status" data-state={state}>
                            <Icon size={15} aria-hidden />
                            {failure
                                ? "Download interrupted"
                                : status.ready
                                  ? "Available offline"
                                  : "Loading pinned graph…"}
                        </output>
                        <span className="ps-pinned-attachments">
                            <Paperclip size={14} aria-hidden />
                            {status.attachments === "all" ? "Includes attachment bytes" : "Objects only"}
                        </span>
                    </div>
                </div>
            </header>
            {failure && (
                <p className="ps-replication-error" role="alert">
                    {failure}
                </p>
            )}
            {status.inputs && Object.keys(status.inputs).length > 0 && (
                <details className="ps-pinned-inputs">
                    <DisclosureSummary>Inputs</DisclosureSummary>
                    <QueryExpression expression={{ kind: "literal", value: { value: status.inputs } }} />
                </details>
            )}
            <QueryDocumentView query={status.query} ir={ir} showFields={false} />
        </div>
    );
}
