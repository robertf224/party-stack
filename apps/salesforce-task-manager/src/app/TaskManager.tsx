import {
    DndContext,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
} from "@dnd-kit/core";
import { createOntologyDevtoolsPlugin, ontologyDevtoolsTrigger } from "@party-stack/ontology-devtools";
import { eq, ilike, queryOnce } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { use, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Temporal } from "temporal-polyfill";
import ontology from "../ontology/ontology";
import { connectSalesforce, restoreSalesforceOntologies, type SalesforceOntologies } from "./salesforce";
import type { Task } from "../ontology/generated/types";
import type { MetaActionType, TypeDef } from "@party-stack/ontology";

const restoredOntologies = restoreSalesforceOntologies();

function stringValue(data: FormData, name: string): string {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
}

export function TaskManager() {
    const restored = use(restoredOntologies);
    const [ontologies, setOntologies] = useState(restored);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState<string>();

    if (!ontologies) {
        return (
            <div className="task-manager-app">
                <main className="loading">
                    <div className="connect-card">
                        <span className="eyebrow">Party Stack integration</span>
                        <h1>Salesforce Task Manager</h1>
                        <p>Connect directly from the browser with OAuth PKCE.</p>
                        {error ? <p className="error">{error}</p> : null}
                        <button
                            disabled={connecting}
                            type="button"
                            onClick={() => {
                                setConnecting(true);
                                void connectSalesforce().then(setOntologies, (reason: unknown) => {
                                    setConnecting(false);
                                    setError(reason instanceof Error ? reason.message : String(reason));
                                });
                            }}
                        >
                            {connecting ? "Connecting…" : "Connect Salesforce"}
                        </button>
                    </div>
                </main>
            </div>
        );
    }

    return <ConnectedTaskManager ontologies={ontologies} />;
}

function ConnectedTaskManager({ ontologies }: { ontologies: SalesforceOntologies }) {
    const { data, meta, userId } = ontologies;
    const { data: tasks } = useLiveQuery(
        (query) =>
            query
                .from({ Task: data.objects.Task })
                .orderBy(({ Task }) => Task.CreatedDate, "desc")
                .limit(50)
                .select(({ Task }) => ({ ...Task })),
        [data]
    );
    const [taskDialog, setTaskDialog] = useState<Task | null>();
    const [saving, setSaving] = useState(false);
    const [movingTaskId, setMovingTaskId] = useState<string>();
    const [error, setError] = useState<string>();
    const [search, setSearch] = useState("");
    const [searching, setSearching] = useState(false);
    const [actionTypes, setActionTypes] = useState<MetaActionType[]>([]);
    const devtools = useMemo(
        () => createOntologyDevtoolsPlugin({ ontology: data, metaOntology: meta }),
        [data, meta]
    );

    async function saveTask(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const activityDate = stringValue(form, "activityDate");
        const input = {
            Subject: stringValue(form, "subject"),
            Status: stringValue(form, "status") as Task["Status"],
            Priority: stringValue(form, "priority") as Task["Priority"],
            ActivityDate: activityDate ? Temporal.PlainDate.from(activityDate) : undefined,
        };
        setSaving(true);
        try {
            if (taskDialog) {
                await data.actions.updateTask({ recordId: taskDialog.Id, ...input });
            } else {
                await data.actions.createTask(input);
            }
            setTaskDialog(undefined);
            formElement.reset();
            setError(undefined);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setSaving(false);
        }
    }

    async function deleteTask(task: Task) {
        if (!window.confirm(`Delete "${task.Subject}"?`)) {
            return;
        }
        try {
            await data.actions.deleteTask({ recordId: task.Id });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }

    async function moveTask(task: Task, status: Task["Status"]) {
        if (task.Status === status) {
            return;
        }
        setMovingTaskId(task.Id);
        try {
            await data.actions.updateTask({ recordId: task.Id, Status: status });
            setError(undefined);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setMovingTaskId(undefined);
        }
    }

    function handleTaskDrop(event: DragEndEvent) {
        const task = tasks.find((candidate) => candidate.Id === event.active.id);
        const status = statusOptions.find((option) => option.value === event.over?.id)?.value as
            | Task["Status"]
            | undefined;
        if (task && status) {
            void moveTask(task, status);
        }
    }

    async function searchActionTypes(exact: boolean) {
        const normalized = search.trim();
        setSearching(true);
        try {
            const rows = await queryOnce((query) => {
                const from = query.from({ ActionType: meta.objects.ActionType });
                if (exact && normalized) {
                    return from.where(({ ActionType }) => eq(ActionType.name, normalized));
                }
                const filtered = normalized
                    ? from.where(({ ActionType }) => ilike(ActionType.name, `%${normalized}%`))
                    : from;
                return filtered.orderBy(({ ActionType }) => ActionType.name, "asc").limit(50);
            });
            setActionTypes(rows);
            setError(undefined);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setSearching(false);
        }
    }

    const taskType = ontology.objectTypes.find((objectType) => objectType.name === "Task");
    const statusOptions = enumOptions("Status");
    const priorityOptions = enumOptions("Priority");
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

    return (
        <>
            <div className="task-manager-app">
                <header>
                    <div className="shell hero">
                        <span className="eyebrow">Browser-native Salesforce</span>
                        <h1>Salesforce Task Manager</h1>
                        <p>
                            Live ontology queries, generated actions, OAuth PKCE, and CDC—all running in the
                            browser.
                        </p>
                    </div>
                </header>
                <main className="shell">
                    <section className="connection">
                        <div>
                            <strong>Connected Salesforce user</strong>
                            <span>{userId}</span>
                        </div>
                        <span className="kind">CDC connected</span>
                    </section>
                    {error ? <p className="error">{error}</p> : null}
                    <section className="stats">
                        <Stat label="Ontology objects" value={ontology.objectTypes.length} />
                        <Stat label="Task fields" value={taskType?.properties.length ?? 0} />
                        <Stat label="Visible tasks" value={tasks.length} />
                        <Stat label="Runtime actions" value={ontology.actionTypes.length} />
                    </section>
                    <section className="grid">
                        <article className="panel wide">
                            <PanelHeading
                                action={
                                    <button type="button" onClick={() => setTaskDialog(null)}>
                                        New task
                                    </button>
                                }
                                title="Tasks"
                                subtitle="Drag tasks between statuses or open one to edit"
                            />
                            <DndContext sensors={sensors} onDragEnd={handleTaskDrop}>
                                <div className="kanban">
                                    {statusOptions.map((status) => (
                                        <TaskColumn
                                            key={status.value}
                                            label={status.label}
                                            status={status.value as Task["Status"]}
                                            tasks={tasks.filter((task) => task.Status === status.value)}
                                            movingTaskId={movingTaskId}
                                            onDelete={deleteTask}
                                            onEdit={(task) => setTaskDialog(task)}
                                        />
                                    ))}
                                </div>
                            </DndContext>
                        </article>
                        <article className="panel wide">
                            <PanelHeading
                                title="Salesforce meta ontology"
                                subtitle="Every result is a complete action type; matching definitions are batch-described through Composite"
                            />
                            <div className="search">
                                <input
                                    aria-label="Action type name"
                                    placeholder="Action API name or text"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                />
                                <button
                                    disabled={searching}
                                    type="button"
                                    onClick={() => void searchActionTypes(false)}
                                >
                                    Search
                                </button>
                                <button
                                    className="secondary"
                                    disabled={searching}
                                    type="button"
                                    onClick={() => void searchActionTypes(true)}
                                >
                                    Load exact
                                </button>
                            </div>
                            <div className="meta-results">
                                {actionTypes.map((action) => (
                                    <details className="meta-action" key={action.name}>
                                        <summary>
                                            <div>
                                                <strong>{action.displayName}</strong>
                                                <span>
                                                    {action.name} · {action.parameters.length} parameters
                                                </span>
                                            </div>
                                            <span className="kind">Expand</span>
                                        </summary>
                                        <div className="parameter-list">
                                            {action.parameters.length ? (
                                                action.parameters.map((parameter) => (
                                                    <ParameterTree
                                                        description={parameter.description}
                                                        displayName={parameter.displayName}
                                                        key={parameter.name}
                                                        name={parameter.name}
                                                        type={parameter.type}
                                                    />
                                                ))
                                            ) : (
                                                <span className="empty">No parameters</span>
                                            )}
                                        </div>
                                    </details>
                                ))}
                            </div>
                        </article>
                    </section>
                    {taskDialog !== undefined ? (
                        <TaskEditorDialog
                            priorityOptions={priorityOptions}
                            saving={saving}
                            statusOptions={statusOptions}
                            task={taskDialog}
                            onClose={() => setTaskDialog(undefined)}
                            onSubmit={(event) => void saveTask(event)}
                        />
                    ) : null}
                </main>
            </div>
            <TanStackDevtools config={{ customTrigger: ontologyDevtoolsTrigger }} plugins={[devtools]} />
        </>
    );
}

function TaskColumn({
    label,
    movingTaskId,
    onDelete,
    onEdit,
    status,
    tasks,
}: {
    label: string;
    movingTaskId?: string;
    onDelete: (task: Task) => Promise<void>;
    onEdit: (task: Task) => void;
    status: Task["Status"];
    tasks: Task[];
}) {
    const { isOver, setNodeRef } = useDroppable({ id: status });
    return (
        <section className={`kanban-column${isOver ? " is-over" : ""}`} ref={setNodeRef}>
            <div className="kanban-column-head">
                <strong>{label}</strong>
                <span>{tasks.length}</span>
            </div>
            <div className="kanban-cards">
                {tasks.map((task) => (
                    <TaskCard
                        key={task.Id}
                        moving={movingTaskId === task.Id}
                        task={task}
                        onDelete={onDelete}
                        onEdit={onEdit}
                    />
                ))}
                {!tasks.length ? <div className="kanban-empty">Drop a task here</div> : null}
            </div>
        </section>
    );
}

function TaskCard({
    moving,
    onDelete,
    onEdit,
    task,
}: {
    moving: boolean;
    onDelete: (task: Task) => Promise<void>;
    onEdit: (task: Task) => void;
    task: Task;
}) {
    const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({ id: task.Id });
    return (
        <article
            className={`task-card${isDragging ? " is-dragging" : ""}`}
            ref={setNodeRef}
            style={{
                transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
            }}
        >
            <div className="task-card-title">
                <strong>{task.Subject || "Untitled task"}</strong>
                <button
                    aria-label={`Drag ${task.Subject || "task"}`}
                    className="drag-handle"
                    disabled={moving}
                    type="button"
                    {...listeners}
                    {...attributes}
                >
                    ⠿
                </button>
            </div>
            <div className="task-card-meta">
                <span className={`priority priority-${task.Priority.toLowerCase()}`}>{task.Priority}</span>
                {task.ActivityDate ? <span>Due {task.ActivityDate.toString()}</span> : null}
            </div>
            <div className="task-card-actions">
                <button className="text-button" disabled={moving} type="button" onClick={() => onEdit(task)}>
                    Edit
                </button>
                <button
                    className="text-button danger-text"
                    disabled={moving}
                    type="button"
                    onClick={() => void onDelete(task)}
                >
                    Delete
                </button>
            </div>
        </article>
    );
}

function TaskEditorDialog({
    onClose,
    onSubmit,
    priorityOptions,
    saving,
    statusOptions,
    task,
}: {
    onClose: () => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    priorityOptions: Array<{ label: string; value: string }>;
    saving: boolean;
    statusOptions: Array<{ label: string; value: string }>;
    task: Task | null;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    return (
        <dialog className="task-dialog" ref={dialog} onCancel={onClose} onClose={onClose}>
            <div className="dialog-head">
                <div>
                    <span className="eyebrow">Salesforce task</span>
                    <h2>{task ? "Edit task" : "New task"}</h2>
                </div>
                <button aria-label="Close dialog" className="dialog-close" type="button" onClick={onClose}>
                    ×
                </button>
            </div>
            <form className="form" onSubmit={onSubmit}>
                <label>
                    Subject
                    <input autoFocus defaultValue={task?.Subject} name="subject" required />
                </label>
                <div className="form-row">
                    <label>
                        Status
                        <select defaultValue={task?.Status ?? statusOptions[0]?.value} name="status">
                            {statusOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Priority
                        <select defaultValue={task?.Priority ?? priorityOptions[0]?.value} name="priority">
                            {priorityOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                <label>
                    Due date
                    <input
                        defaultValue={
                            typeof task?.ActivityDate === "string"
                                ? task.ActivityDate
                                : task?.ActivityDate?.toString()
                        }
                        name="activityDate"
                        type="date"
                    />
                </label>
                <div className="dialog-actions">
                    <button className="secondary" type="button" onClick={onClose}>
                        Cancel
                    </button>
                    <button disabled={saving} type="submit">
                        {saving ? "Saving…" : task ? "Save changes" : "Create task"}
                    </button>
                </div>
            </form>
        </dialog>
    );
}

function ParameterTree({
    description,
    displayName,
    name,
    type,
}: {
    description?: string;
    displayName: string;
    name: string;
    type: TypeDef;
}) {
    return (
        <div className="parameter">
            <div className="parameter-heading">
                <div>
                    <strong>{displayName}</strong>
                    <code>{name}</code>
                </div>
                <span className="type-badge">{typeLabel(type)}</span>
            </div>
            {description ? <p>{description}</p> : null}
            <NestedType type={type} />
        </div>
    );
}

function NestedType({ type }: { type: TypeDef }) {
    switch (type.kind) {
        case "optional":
            return (
                <div className="nested-type">
                    <NestedType type={type.value.type} />
                </div>
            );
        case "list":
            return (
                <div className="nested-type">
                    <div className="type-row">
                        <span>Items</span>
                        <span className="type-badge">{typeLabel(type.value.elementType)}</span>
                    </div>
                    <NestedType type={type.value.elementType} />
                </div>
            );
        case "map":
            return (
                <div className="nested-type">
                    <div className="type-row">
                        <span>Keys</span>
                        <span className="type-badge">{typeLabel(type.value.keyType)}</span>
                    </div>
                    <div className="type-row">
                        <span>Values</span>
                        <span className="type-badge">{typeLabel(type.value.valueType)}</span>
                    </div>
                    <NestedType type={type.value.valueType} />
                </div>
            );
        case "struct":
            return (
                <div className="nested-fields">
                    {type.value.fields.map((field) => (
                        <ParameterTree
                            description={field.description}
                            displayName={field.displayName}
                            key={field.name}
                            name={field.name}
                            type={field.type}
                        />
                    ))}
                </div>
            );
        case "union":
            return (
                <div className="nested-fields">
                    {type.value.variants.map((variant) => (
                        <ParameterTree
                            displayName={variant.name}
                            key={variant.name}
                            name={variant.name}
                            type={variant.type}
                        />
                    ))}
                </div>
            );
        case "result":
            return (
                <div className="nested-type">
                    <div className="type-row">
                        <span>Success</span>
                        <span className="type-badge">{typeLabel(type.value.okType)}</span>
                    </div>
                    <NestedType type={type.value.okType} />
                    <div className="type-row">
                        <span>Error</span>
                        <span className="type-badge">{typeLabel(type.value.errType)}</span>
                    </div>
                    <NestedType type={type.value.errType} />
                </div>
            );
        default:
            return null;
    }
}

function typeLabel(type: TypeDef): string {
    switch (type.kind) {
        case "optional":
            return `${typeLabel(type.value.type)}?`;
        case "list":
            return `${typeLabel(type.value.elementType)}[]`;
        case "map":
            return `map<${typeLabel(type.value.valueType)}>`;
        case "struct":
            return "object";
        case "union":
            return "union";
        case "result":
            return "result";
        case "ref":
            return type.value.name;
        case "objectReference":
            return `reference<${type.value.objectType}>`;
        default:
            return type.kind;
    }
}

function enumOptions(propertyName: string): Array<{ label: string; value: string }> {
    const property = ontology.objectTypes
        .find((objectType) => objectType.name === "Task")
        ?.properties.find((candidate) => candidate.name === propertyName);
    const propertyType = property?.type as TypeDef | undefined;
    const type = propertyType?.kind === "optional" ? propertyType.value.type : propertyType;
    if (type?.kind !== "string" || type.value.constraint?.kind !== "enum") {
        return [];
    }
    return type.value.constraint.value.options.map((option) => ({
        value: option.value,
        label: option.label ?? option.value,
    }));
}

function PanelHeading({ action, title, subtitle }: { action?: ReactNode; title: string; subtitle: string }) {
    return (
        <div className="panel-head">
            <div>
                <h2>{title}</h2>
                <span>{subtitle}</span>
            </div>
            {action}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className="stat">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}
