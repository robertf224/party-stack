import { DbClient } from "@tanstack/db";
import { Component, StrictMode, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { OntologyProvider, useAttachmentMetadata, useAttachmentUrl, useOfflinePin } from "../src/index.js";
import type { LiveOntology } from "@party-stack/ontology";
import type { attachment } from "@party-stack/ontology/values";
import type { ReactNode } from "react";

const reads: {
    value: attachment;
    signal: AbortSignal;
    resolve: (value: Blob) => void;
    reject: (error: Error) => void;
}[] = [];
const revoked: string[] = [];
const created: string[] = [];
const fields: string[][] = [];
const pinCommands: string[] = [];
let listeners = 0;
const revoke = URL.revokeObjectURL.bind(URL);
const create = URL.createObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
    revoked.push(url);
    revoke(url);
};
URL.createObjectURL = (blob) => {
    const url = create(blob);
    created.push(url);
    return url;
};
const ontology = {
    dbClient: new DbClient(),
    attachments: {
        blob: (value: attachment, { signal }: { signal: AbortSignal }) =>
            new Promise<Blob>((resolve, reject) => reads.push({ value, signal, resolve, reject })),
        metadata: (_value: attachment, { select }: { select: string[] }) => {
            fields.push(select);
            return Promise.resolve({ name: "photo.png", size: 123 });
        },
    },
    pins: {
        subscribe: (notify: (value: undefined) => void) => {
            listeners++;
            notify(undefined);
            return () => {
                listeners--;
            };
        },
        set: () => {
            pinCommands.push("set");
            return Promise.resolve();
        },
        clear: () => {
            pinCommands.push("clear");
            return Promise.resolve();
        },
    },
} as unknown as LiveOntology;
function Hooks({ enabled, slot, source }: { enabled: boolean; slot: string; source: number }) {
    // Fresh equivalent handles and reversed field order must still share requests.
    const handle = { id: "photo", source: { objectType: "File", primaryKey: source, property: "file" } };
    const image = useAttachmentUrl(handle, { enabled });
    const metadata = useAttachmentMetadata(handle, {
        select: slot === "first" ? ["name", "size"] : ["size", "name"],
        enabled,
    });
    const pin = useOfflinePin();
    return (
        <>
            <span data-testid={`url-${slot}`}>{image}</span>
            <span data-testid={`metadata-${slot}`}>{metadata?.name}</span>
            {slot === "first" && (
                <>
                    <button onClick={() => void pin.set({ select: [] })}>Pin</button>
                    <button onClick={() => void pin.clear()}>Unpin</button>
                </>
            )}
        </>
    );
}
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
    state: { error?: Error } = {};
    static getDerivedStateFromError(error: Error) {
        return { error };
    }
    render() {
        return this.state.error ? (
            <span data-testid="error">{this.state.error.message}</span>
        ) : (
            this.props.children
        );
    }
}
function App() {
    const [enabled, setEnabled] = useState(true);
    const [second, setSecond] = useState(true);
    const [mounted, setMounted] = useState(true);
    const [generation, setGeneration] = useState(0);
    const [source, setSource] = useState(1);
    return (
        <>
            <button onClick={() => setEnabled(!enabled)}>Toggle</button>
            <button onClick={() => setSecond(!second)}>Second</button>
            <button onClick={() => setMounted(false)}>Close view</button>
            <button onClick={() => setGeneration((value) => value + 1)}>Reset view</button>
            <button onClick={() => setSource((value) => value + 1)}>Source</button>
            {mounted && (
                <Suspense fallback={<span data-testid="opening">Opening view</span>}>
                    <OntologyProvider ontology={ontology} key={generation}>
                        <ErrorBoundary>
                            <Suspense fallback={<span data-testid="pending-first">Bytes pending</span>}>
                                <Hooks enabled={enabled} slot="first" source={source} />
                            </Suspense>
                            {second && (
                                <Suspense fallback={<span data-testid="pending-second">Bytes pending</span>}>
                                    <Hooks enabled={enabled} slot="second" source={source} />
                                </Suspense>
                            )}
                        </ErrorBoundary>
                    </OntologyProvider>
                </Suspense>
            )}
        </>
    );
}
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
Reflect.set(window, "attachmentFixture", {
    state: () => ({
        reads: reads.map((read) => ({ aborted: read.signal.aborted, source: read.value.source })),
        revoked,
        created,
        fields,
        pinCommands,
        listeners,
    }),
    resolve: (index: number) => reads[index]!.resolve(new Blob(["image"], { type: "image/png" })),
    reject: (index: number) => reads[index]!.reject(new Error("Unavailable")),
});
