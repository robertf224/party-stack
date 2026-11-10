import { OntologyDevtoolsPanel } from "@party-stack/ontology-devtools";
import { OntologyProvider, useOntology } from "@party-stack/ontology-react";
import { workerClient } from "@party-stack/ontology/worker";
import { webRuntime } from "@party-stack/web-runtime";
import { and, eq, ilike, or, type InitialQueryBuilder } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { Play, RotateCcw, Trash2 } from "lucide-react";
import { Component, Suspense, useState, type ReactNode } from "react";
import { objects } from "./collections";

const options = {
    client: workerClient(
        () =>
            new SharedWorker(new URL("./owner.worker.ts", import.meta.url), {
                type: "module",
                name: "party-stack-playground-v1",
            })
    ),
    runtime: webRuntime({ storage: "memory" }),
    writes: { defaultVisibility: "optimistic" as const },
};
const initialQuery = (q: InitialQueryBuilder) =>
    q.from({ todo: objects.Todo }).orderBy(({ todo }) => todo.title);
const initialCode = `q => q
  .from({ todo: objects.Todo })
  .orderBy(({ todo }) => todo.title, "asc")`;
const unfinishedCode = `q => q
  .from({ todo: objects.Todo })
  .where(({ todo }) => eq(todo.done, false))
  .orderBy(({ todo }) => todo.title, "asc")`;

class DemoBoundary extends Component<{ children: ReactNode }, { error?: string }> {
    state: { error?: string } = {};
    static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    render() {
        return this.state.error ? (
            <p className="demo-error" role="alert">
                {this.state.error}
            </p>
        ) : (
            this.props.children
        );
    }
}

export default function Demo() {
    if (typeof SharedWorker === "undefined")
        return <p>This demo needs a browser with SharedWorker support.</p>;
    return (
        <DemoBoundary>
            <Suspense fallback={<p className="demo-loading">Opening playground…</p>}>
                <OntologyProvider {...options}>
                    <Workspace />
                </OntologyProvider>
            </Suspense>
        </DemoBoundary>
    );
}

function Workspace() {
    const ontology = useOntology();
    const [code, setCode] = useState(initialCode);
    const [run, setRun] = useState({ query: initialQuery, revision: 0 });
    const [error, setError] = useState<string>();
    const [inspector, setInspector] = useState(false);
    function execute() {
        try {
            // Only explicit Run executes user-edited JavaScript. No remote code or URL state is loaded.
            // eslint-disable-next-line typescript/no-implied-eval -- The user explicitly runs their own playground query.
            const query = new Function(
                "objects",
                "eq",
                "and",
                "or",
                "ilike",
                `"use strict"; return (${code});`
            )(objects, eq, and, or, ilike);
            if (typeof query !== "function")
                throw new Error("Enter a query function, such as q => q.from({ todo: objects.Todo }).");
            setRun({ query, revision: run.revision + 1 });
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    return (
        <>
            <div className="demo-workspace">
                <div className="demo-code">
                    <div className="demo-bar">
                        <label htmlFor="todo-query">Client query · JavaScript</label>
                        <button type="button" onClick={() => setCode(unfinishedCode)}>
                            Try unfinished
                        </button>
                    </div>
                    <textarea
                        id="todo-query"
                        spellCheck={false}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                    />
                    <div className="demo-bar">
                        <button type="button" onClick={() => setCode(initialCode)}>
                            <RotateCcw size={14} />
                            Reset code
                        </button>
                        <button type="button" className="demo-run" onClick={execute}>
                            <Play size={14} />
                            Run query
                        </button>
                    </div>
                    {error && (
                        <p className="demo-error" role="alert">
                            {error}
                        </p>
                    )}
                </div>
                <div className="demo-preview">
                    <h3>Party checklist</h3>
                    <CreateTodo />
                    <DemoBoundary key={run.revision}>
                        <Suspense fallback={<p>Reading todos…</p>}>
                            <Todos query={run.query} />
                        </Suspense>
                    </DemoBoundary>
                </div>
            </div>
            <div className="demo-caption">
                <p>
                    Edits run in this page. Todos live in shared worker memory. Open a second tab to see them
                    sync.
                </p>
                <button type="button" aria-expanded={inspector} onClick={() => setInspector(!inspector)}>
                    {inspector ? "Hide devtools" : "Open devtools"}
                </button>
            </div>
            {inspector && (
                <div className="demo-inspector">
                    <OntologyDevtoolsPanel ontology={ontology} theme="dark" />
                </div>
            )}
        </>
    );
}

function CreateTodo() {
    const ontology = useOntology();
    const [title, setTitle] = useState("");
    const [error, setError] = useState<string>();
    return (
        <form
            className="demo-create"
            onSubmit={(event) => {
                event.preventDefault();
                if (!title.trim()) return;
                const text = title.trim();
                setTitle("");
                setError(undefined);
                void ontology.actions.createTodo!({ title: text }).catch((cause) => setError(String(cause)));
            }}
        >
            <input
                aria-label="New todo"
                placeholder="Add something to do"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" disabled={!title.trim()}>
                Add
            </button>
            {error && (
                <p className="demo-error" role="alert">
                    {error}
                </p>
            )}
        </form>
    );
}

function Todos({ query }: { query: typeof initialQuery }) {
    const ontology = useOntology();
    const { data } = useLiveSuspenseQuery(query);
    const [error, setError] = useState<string>();
    const submit = (work: Promise<unknown>) => {
        setError(undefined);
        void work.catch((cause) => setError(String(cause)));
    };
    return (
        <>
            {error && (
                <p className="demo-error" role="alert">
                    {error}
                </p>
            )}
            <ul className="demo-todos">
                {data.map((todo) => (
                    <li key={todo.id}>
                        <label>
                            <input
                                type="checkbox"
                                checked={todo.done}
                                onChange={(event) =>
                                    submit(
                                        ontology.actions.setDone!({
                                            todo: todo.id,
                                            done: event.target.checked,
                                        })
                                    )
                                }
                            />
                            <span data-done={todo.done}>{todo.title}</span>
                        </label>
                        <button
                            type="button"
                            aria-label={`Delete ${todo.title}`}
                            onClick={() => submit(ontology.actions.deleteTodo!({ todo: todo.id }))}
                        >
                            <Trash2 size={15} />
                        </button>
                    </li>
                ))}
            </ul>
            {!data.length && <p>No matching todos.</p>}
        </>
    );
}
