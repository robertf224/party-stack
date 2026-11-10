import { CircleAlert, CircleCheck, LoaderCircle, Paperclip } from "lucide-react";
import { useState } from "react";
import { QueryDocumentView, QueryExpression } from "./QueryView.js";
import type { OntologyIR, PinRecord } from "@party-stack/ontology";

export function groupPinDownloads(pins: readonly PinRecord[]) {
    const families = new Map<string, { name: string; revisions: Map<string, PinRecord[]> }>();
    for (const pin of pins) {
        let family = families.get(pin.name);
        if (!family) {
            family = { name: pin.name, revisions: new Map() };
            families.set(pin.name, family);
        }
        const downloads = family.revisions.get(pin.definition);
        if (downloads) downloads.push(pin);
        else family.revisions.set(pin.definition, [pin]);
    }
    return [...families.values()];
}

export function PinnedFamily({
    family,
    ir,
    remove,
}: {
    family: ReturnType<typeof groupPinDownloads>[number];
    ir: OntologyIR;
    remove: (id: string) => Promise<void>;
}) {
    return (
        <section className="ps-diagnostics-screen ps-pinned-screen ps-pinned-family" aria-label={family.name}>
            <header className="ps-pinned-header">
                <h2>{family.name}</h2>
            </header>
            {[...family.revisions].map(([definition, pins]) => (
                <div className="ps-pin-revision" key={definition}>
                    <div className="ps-pinned-meta">
                        {family.revisions.size > 1 && (
                            <code title={definition}>Revision {definition.slice(0, 8)}</code>
                        )}
                        <span className="ps-pinned-attachments">
                            <Paperclip size={14} aria-hidden />
                            {pins[0]!.attachments === "all" ? "Includes attachment bytes" : "Objects only"}
                        </span>
                    </div>
                    <div className="ps-pin-downloads">
                        {pins.map((pin) => (
                            <PinDownload key={pin.id} pin={pin} remove={remove} />
                        ))}
                    </div>
                    <QueryDocumentView query={pins[0]!.query} ir={ir} />
                </div>
            ))}
        </section>
    );
}

function PinDownload({ pin, remove }: { pin: PinRecord; remove: (id: string) => Promise<void> }) {
    const [failure, setFailure] = useState<string>();
    const error = failure ?? pin.error?.message;
    const state = error ? "error" : pin.ready ? "ready" : "loading";
    const Icon = error ? CircleAlert : pin.ready ? CircleCheck : LoaderCircle;
    return (
        <div className="ps-pin-download" data-pin-id={pin.id}>
            <div className="ps-pin-inputs">
                {Object.keys(pin.inputs).length ? (
                    <QueryExpression expression={{ kind: "literal", value: { value: pin.inputs } }} />
                ) : (
                    <span>No inputs</span>
                )}
                {error && (
                    <p role="alert" className="ps-replication-error">
                        {error}
                    </p>
                )}
            </div>
            <output className="ps-pinned-status" data-state={state}>
                <Icon size={15} aria-hidden />
                {error ? "Interrupted" : pin.ready ? "Available offline" : "Downloading…"}
            </output>
            <button
                type="button"
                className="ps-pinned-remove"
                onClick={() => {
                    setFailure(undefined);
                    void remove(pin.id).catch((error: unknown) =>
                        setFailure(error instanceof Error ? error.message : "Could not remove download.")
                    );
                }}
            >
                {pin.ready || error ? "Remove" : "Cancel"}
            </button>
        </div>
    );
}
