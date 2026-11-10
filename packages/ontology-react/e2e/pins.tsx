import { DbClient } from "@tanstack/db";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OntologyProvider, useOfflinePin } from "../src/index.js";
import type { LiveOntology, PinStatus, QueryDocument } from "@party-stack/ontology";

const listeners = new Set<(status: PinStatus | undefined) => void>();
const retired: ((status: PinStatus | undefined) => void)[] = [];
const queued: (PinStatus | undefined)[] = [];
const query: QueryDocument = { select: [] };
const downloading: PinStatus = { query, attachments: "all", ready: false, previousGraphRetained: false };
const commands: string[] = [];
const ontology = {
    dbClient: new DbClient(),
    pins: {
        subscribe: (notify: (status: PinStatus | undefined) => void) => {
            listeners.add(notify);
            notify(undefined);
            return () => {
                listeners.delete(notify);
                retired.push(notify);
            };
        },
        set: () => {
            commands.push("set");
            queued.push(downloading);
            return Promise.resolve();
        },
        clear: () => {
            commands.push("clear");
            queued.push(undefined);
            return Promise.resolve();
        },
    },
} as unknown as LiveOntology;
function App() {
    const pin = useOfflinePin();
    return (
        <>
            <label>
                Download
                <input
                    type="checkbox"
                    checked={Boolean(pin.status)}
                    disabled={pin.isLoading}
                    onChange={(event) => void (event.target.checked ? pin.set(query) : pin.clear())}
                />
            </label>
            <output>{pin.status ? "Downloading" : "Off"}</output>
        </>
    );
}
Reflect.set(window, "pinFixture", {
    state: () => ({ commands, queued: queued.length, retired: retired.length }),
    deliver: () => {
        const next = queued.shift();
        for (const notify of listeners) notify(next);
    },
    deliverObsolete: () => {
        for (const notify of retired) notify(downloading);
    },
});
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <OntologyProvider ontology={ontology}>
            <App />
        </OntologyProvider>
    </StrictMode>
);
