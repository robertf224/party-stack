import { PartyStackLogomark } from "@party-stack/design-system/brand";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { CircleAlert, CircleCheck, LoaderCircle, Paperclip, Pin } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { DisclosureSummary } from "./DisclosureSummary.js";
import { PinnedFamily, groupPinDownloads } from "./PinnedFamily.js";
import { QueryDocumentView, QueryExpression } from "./QueryView.js";
import type { LiveOntology, OntologyIR, PinStatus } from "@party-stack/ontology";

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
    const [snapshot, setSnapshot] = useState<{ pins: typeof pins; status?: PinStatus; error?: unknown }>();
    useEffect(() => {
        let active = true;
        let unsubscribe = () => {};
        const onError = (error: unknown) => {
            if (active) setSnapshot({ pins, error });
        };
        try {
            unsubscribe = pins.subscribe((status) => {
                if (active) setSnapshot({ pins, status });
            }, onError);
        } catch (error) {
            onError(error);
        }
        return () => {
            active = false;
            unsubscribe();
        };
    }, [pins]);
    const current = snapshot?.pins === pins ? snapshot : undefined;
    if (!downloads.length)
        return (
            <PinnedContent
                ir={ontology.ir}
                status={current?.status}
                loading={!current}
                error={current?.error}
            />
        );
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
            {current?.status && (
                <PinnedContent ir={ontology.ir} status={current.status} title="Legacy application download" />
            )}
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
    status?: PinStatus;
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
            {status.previousGraphRetained && (
                <p className="ps-pinned-retained">
                    The previous graph is retained until this replacement is ready.
                </p>
            )}
            {status.inputs && Object.keys(status.inputs).length > 0 && (
                <details className="ps-pinned-inputs">
                    <DisclosureSummary>Inputs</DisclosureSummary>
                    <QueryExpression expression={{ kind: "literal", value: { value: status.inputs } }} />
                </details>
            )}
            <QueryDocumentView query={status.query} ir={ir} />
        </div>
    );
}
