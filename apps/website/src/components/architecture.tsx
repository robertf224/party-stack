import { useEffect, useState } from "react";
import "./architecture.css";

type Mode = "direct" | "worker" | "tree";
type NodeId = "backend" | "cloud" | "worker" | "tab" | "other";
const nodes: Record<NodeId, { title: string; storage: string }> = {
    backend: { title: "Owned backend", storage: "SQLite or PostgreSQL" },
    cloud: { title: "Server replica", storage: "SQLite + file storage" },
    worker: { title: "SharedWorker replica", storage: "IndexedDB + OPFS" },
    tab: { title: "Your tab", storage: "Memory" },
    other: { title: "Another tab", storage: "Memory" },
};
const modes: { id: Mode; title: string }[] = [
    { id: "direct", title: "Tab → server" },
    { id: "worker", title: "Add a SharedWorker" },
    { id: "tree", title: "Add a server replica" },
];

export function ArchitectureExplorer() {
    const [mode, setMode] = useState<Mode>("worker");
    const [step, setStep] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [rejected, setRejected] = useState(false);
    const [offline, setOffline] = useState(false);
    const [focus, setFocus] = useState<NodeId>("tab");
    const worker = mode !== "direct";
    const cloud = mode === "tree";
    const commitStep = cloud ? 4 : worker ? 3 : 2;
    const finalStep = commitStep + 1;
    const limit = offline ? (worker ? 2 : 1) : finalStep;
    const done = step === finalStep;
    const committed = step >= commitStep && !rejected;
    const predicted = step > 0 && !(done && rejected);
    const phases = [
        {
            title: "Read an issue",
            text: "Every replica starts with Issue #42 open. Select a box to look inside it.",
        },
        {
            title: "Change its status",
            text: "Your tab records updateIssue in its outbox. Its local overlay makes the issue appear In Progress immediately.",
        },
        ...(worker
            ? [
                  {
                      title: "The worker accepts",
                      text: "The SharedWorker saves the action durably. Both tabs can now see its prediction, before the backend commits.",
                  },
              ]
            : []),
        ...(cloud
            ? [
                  {
                      title: "The server replica accepts",
                      text: "The server replica takes responsibility for forwarding the action. Its outbox is durable too.",
                  },
              ]
            : []),
        {
            title: rejected ? "The backend rejects" : "The backend commits",
            text: rejected
                ? "The backend returns ValidationFailed. The authoritative issue stays Open."
                : "The backend commits the issue row, action receipt and change journal together.",
        },
        {
            title: "Reconcile each replica",
            text: rejected
                ? "The rejection travels back. This example discards the rejected action and removes its prediction, so both tabs show Open again."
                : "Confirmed rows and the result travel down. Each replica updates its base and removes the matching prediction in one local transaction.",
        },
    ];
    useEffect(() => {
        if (!playing || step >= limit) return;
        const timer = window.setTimeout(() => {
            setStep(step + 1);
            if (step + 1 >= limit) setPlaying(false);
        }, 1800);
        return () => window.clearTimeout(timer);
    }, [playing, step, limit]);

    const activeNodes: NodeId[] = [
        "backend",
        ...(cloud ? ["cloud" as const] : []),
        ...(worker ? ["worker" as const] : []),
        "tab",
        "other",
    ];
    const selected = activeNodes.includes(focus) ? focus : "tab";
    const local = (id: NodeId) => {
        const accepted = id === "tab" ? worker && step >= 2 : id === "worker" ? cloud && step >= 3 : false;
        const received = id === "other" ? worker && step >= 2 : accepted;
        const base = done ? (rejected ? "Open" : "In Progress") : received ? "In Progress" : "Open";
        const pending =
            !done &&
            (id === "tab" ? step >= 1 : id === "worker" ? step >= 2 : id === "cloud" ? step >= 3 : false);
        return {
            base,
            optimistic: id === "other" ? worker && step >= 2 && !done : pending || (received && !done),
            visible:
                id === "other" && !worker
                    ? done && !rejected
                        ? "In Progress"
                        : "Open"
                    : predicted &&
                        (id === "tab" ||
                            (id === "worker" && step >= 2) ||
                            (id === "cloud" && step >= 3) ||
                            received)
                      ? "In Progress"
                      : base,
            outbox: pending ? (accepted ? "Accepted by parent" : "updateIssue · queued") : "Empty",
            overlay: pending && !accepted ? "status = In Progress" : "None",
        };
    };
    const snapshot =
        selected === "backend"
            ? {
                  issue: {
                      id: "issue-42",
                      title: "Review launch",
                      status: committed ? "In Progress" : "Open",
                  },
                  result:
                      step >= commitStep
                          ? rejected
                              ? "ValidationFailed"
                              : { operationId: "action-7", outcome: "committed" }
                          : null,
                  journal: committed ? [{ objectType: "Issue", key: "issue-42", status: "In Progress" }] : [],
              }
            : {
                  base: { id: "issue-42", status: local(selected).base },
                  outbox:
                      local(selected).outbox === "Empty"
                          ? []
                          : [{ id: "action-7", name: "updateIssue", state: local(selected).outbox }],
                  overlay: local(selected).overlay,
                  visible: { id: "issue-42", status: local(selected).visible },
              };
    const node = (id: NodeId) => (
        <button
            type="button"
            key={id}
            className={`arch-node ${selected === id ? "arch-selected" : ""}`}
            aria-pressed={selected === id}
            onClick={() => setFocus(id)}
        >
            <span className="arch-node-heading">
                {nodes[id].title}
                <small>{nodes[id].storage}</small>
            </span>
            <span className="arch-node-row">
                <span>Issue #42</span>
                <strong>{id === "backend" ? (committed ? "In Progress" : "Open") : local(id).visible}</strong>
            </span>
            <span className="arch-node-note">
                {id === "backend"
                    ? committed
                        ? "Row + receipt + journal committed"
                        : rejected && step >= commitStep
                          ? "Validation failed · row unchanged"
                          : "Authoritative rows"
                    : `Outbox: ${local(id).outbox}`}
            </span>
        </button>
    );
    const edge = (name: string, index: number) => (
        <div
            className={`arch-edge ${(step > 0 && !offline) || done ? "arch-edge-moving" : ""}`}
            key={`${mode}-${step}-${name}`}
        >
            <span
                className={`arch-edge-track ${done ? "arch-down" : ""}`}
                style={{ animationDelay: `${index * 200}ms` }}
            />
            <span>{done ? (rejected ? "Failure ↓" : "Rows + result ↓") : name}</span>
        </div>
    );

    return (
        <section className="arch-explorer not-prose" aria-label="Explore a replicated issue update">
            <div className="arch-modes" aria-label="Deployment">
                {modes.map((option) => (
                    <button
                        type="button"
                        key={option.id}
                        aria-pressed={mode === option.id}
                        onClick={() => {
                            setMode(option.id);
                            setStep(0);
                            setPlaying(false);
                        }}
                    >
                        {option.title}
                    </button>
                ))}
            </div>
            <div className="arch-options">
                <label>
                    <input
                        type="checkbox"
                        checked={rejected}
                        onChange={(event) => {
                            setRejected(event.target.checked);
                            setStep(0);
                            setPlaying(false);
                        }}
                    />{" "}
                    Reject the action
                </label>
                <label>
                    <input
                        type="checkbox"
                        checked={offline}
                        onChange={(event) => {
                            setOffline(event.target.checked);
                            setStep((current) => Math.min(current, worker ? 2 : 1));
                            setPlaying(false);
                        }}
                    />{" "}
                    Upstream offline
                </label>
            </div>
            <div className="arch-story" aria-live="polite">
                <span className="arch-step">
                    {step + 1} / {phases.length}
                </span>
                <h3>{phases[step]!.title}</h3>
                <p>{phases[step]!.text}</p>
                {offline && step >= limit && (
                    <p className="arch-offline">
                        {worker
                            ? "The worker keeps the action on disk. Reconnect to continue."
                            : "This tab has only a memory outbox. Reconnect before closing it."}
                    </p>
                )}
            </div>
            <div className="arch-controls">
                <button
                    type="button"
                    onClick={() => {
                        setPlaying(!playing);
                        if (step === finalStep) setStep(0);
                    }}
                    disabled={offline && step >= limit}
                >
                    {playing ? "Pause" : "Play"}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setPlaying(false);
                        setStep(Math.max(0, step - 1));
                    }}
                    disabled={step === 0}
                >
                    Back
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setPlaying(false);
                        setStep(Math.min(limit, step + 1));
                    }}
                    disabled={step >= limit}
                >
                    Next
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setPlaying(false);
                        setStep(0);
                    }}
                >
                    Reset
                </button>
            </div>
            <div className="arch-workspace">
                <div className="arch-tree">
                    {node("backend")}
                    {edge("Action ↑", 0)}
                    {cloud && (
                        <>
                            {node("cloud")}
                            {edge("Action ↑", 1)}
                        </>
                    )}
                    {worker && (
                        <>
                            {node("worker")}
                            {edge("Action ↑ · parent view ↓", 2)}
                        </>
                    )}
                    <div className="arch-tabs">
                        {node("tab")}
                        {node("other")}
                    </div>
                </div>
                <div className="arch-inside">
                    <span className="arch-inside-label">INSIDE {nodes[selected].title.toUpperCase()}</span>
                    <pre>{JSON.stringify(snapshot, null, 2)}</pre>
                    {selected !== "backend" && (
                        <p>
                            {local(selected).optimistic
                                ? "The visible row includes a prediction. Confirmed-only reads still show Open until reconciliation."
                                : "The visible row comes from the confirmed base. There is no active prediction."}
                        </p>
                    )}
                    <div className="arch-app-preview">
                        <small>APP VIEW</small>
                        <span>Review launch</span>
                        <strong>{predicted ? "In Progress" : "Open"}</strong>
                    </div>
                </div>
            </div>
        </section>
    );
}
