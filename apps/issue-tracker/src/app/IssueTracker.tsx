import { Button } from "@base-ui/react/button";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import {
    closestCorners,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { eq, ilike, useLiveQuery } from "@tanstack/react-db";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useNavigate } from "@tanstack/react-router";
import { createOntologyDevtoolsPlugin, ontologyDevtoolsTrigger } from "@party-stack/ontology-devtools";
import type { AttachmentMetadata } from "@party-stack/ontology";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Temporal } from "temporal-polyfill";
import type {
    CreateIssueParameters,
    Issue,
    Project,
    UpdateIssueParameters,
    User,
} from "../ontology/generated/types";
import {
    connectFoundryProfile,
    connectGoogleProfile,
    connectSqliteProfile,
    disconnectProfile,
    getIssueTrackerProfiles,
    subscribeProfileConnection,
    type ConnectedProfile,
    type TrackerOntology,
} from "./profiles";
import { FormInput, FormSelect, FormTextarea } from "../components/FormControls";

const STATUSES = ["Open", "In Progress", "Waiting", "Completed"] as const;
type IssueStatus = (typeof STATUSES)[number];

const ISSUE_SECTIONS = [
    { status: "Waiting", label: "Waiting" },
    { status: "In Progress", label: "In progress" },
    { status: "Open", label: "Open" },
    { status: "Completed", label: "Done" },
] as const satisfies ReadonlyArray<{
    status: IssueStatus;
    label: string;
}>;

const kanbanKeyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
    switch (event.code) {
        case "ArrowLeft":
            return {
                ...currentCoordinates,
                x: currentCoordinates.x - 300,
            };
        case "ArrowRight":
            return {
                ...currentCoordinates,
                x: currentCoordinates.x + 300,
            };
        case "ArrowUp":
            return {
                ...currentCoordinates,
                y: currentCoordinates.y - 80,
            };
        case "ArrowDown":
            return {
                ...currentCoordinates,
                y: currentCoordinates.y + 80,
            };
        default:
            return undefined;
    }
};

const PROJECT_COLORS = ["#5E6AD2", "#E5484D", "#F5A524", "#30A46C", "#0091FF", "#AB4ABA"];

type IconName =
    | "archive"
    | "attachment"
    | "check"
    | "chevron"
    | "circle"
    | "close"
    | "dots"
    | "grip"
    | "inbox"
    | "issue"
    | "kanban"
    | "list"
    | "plus"
    | "project"
    | "search"
    | "trash";

function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
    const paths: Record<IconName, ReactNode> = {
        archive: (
            <>
                <path d="M4 7h16v12H4z" />
                <path d="M3 3h18v4H3zM9 11h6" />
            </>
        ),
        attachment: (
            <path d="m20.5 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        ),
        check: <path d="m5 12 4 4L19 6" />,
        chevron: <path d="m9 18 6-6-6-6" />,
        circle: <circle cx="12" cy="12" r="8" />,
        close: <path d="m6 6 12 12M18 6 6 18" />,
        dots: (
            <>
                <circle cx="5" cy="12" r="1" fill="currentColor" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
                <circle cx="19" cy="12" r="1" fill="currentColor" />
            </>
        ),
        grip: (
            <>
                <circle cx="9" cy="7" r="1" fill="currentColor" stroke="none" />
                <circle cx="15" cy="7" r="1" fill="currentColor" stroke="none" />
                <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
                <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
                <circle cx="9" cy="17" r="1" fill="currentColor" stroke="none" />
                <circle cx="15" cy="17" r="1" fill="currentColor" stroke="none" />
            </>
        ),
        inbox: (
            <>
                <path d="M4 5h16v14H4z" />
                <path d="M4 14h4l2 2h4l2-2h4" />
            </>
        ),
        issue: (
            <>
                <rect height="16" rx="2" width="14" x="5" y="4" />
                <path d="m8.5 9 1.5 1.5L12.5 8M14 9h2M8.5 15H16" />
            </>
        ),
        kanban: (
            <>
                <rect height="16" rx="2" width="18" x="3" y="4" />
                <path d="M9 4v16M15 4v16" />
            </>
        ),
        list: (
            <>
                <path d="M9 6h11M9 12h11M9 18h11" />
                <circle cx="5" cy="6" fill="currentColor" r="1" stroke="none" />
                <circle cx="5" cy="12" fill="currentColor" r="1" stroke="none" />
                <circle cx="5" cy="18" fill="currentColor" r="1" stroke="none" />
            </>
        ),
        plus: <path d="M12 5v14M5 12h14" />,
        project: (
            <>
                <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
            </>
        ),
        search: (
            <>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
            </>
        ),
        trash: (
            <>
                <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
            </>
        ),
    };

    return (
        <svg
            aria-hidden
            className={className}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
        >
            {paths[name]}
        </svg>
    );
}

function statusColor(status: string) {
    switch (status) {
        case "Completed":
            return "text-violet-500";
        case "In Progress":
            return "text-amber-500";
        case "Waiting":
            return "text-sky-400";
        default:
            return "text-slate-400";
    }
}

function statusSurfaceClass(status: string) {
    switch (status) {
        case "Waiting":
            return "status-waiting";
        case "In Progress":
            return "status-in-progress";
        case "Completed":
            return "status-completed";
        default:
            return "status-open";
    }
}

function StatusIcon({ status, className = "size-4" }: { status: string; className?: string }) {
    return (
        <svg
            aria-hidden
            className={`${className} ${statusColor(status)}`}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
        >
            <circle cx="12" cy="12" fill={status === "Completed" ? "currentColor" : "none"} r="8" />
            {status === "In Progress" && (
                <>
                    <path d="M12 8v4l3 2" />
                    <circle cx="12" cy="12" fill="currentColor" r="1" stroke="none" />
                </>
            )}
            {status === "Waiting" && (
                <>
                    <path d="M10 9v6M14 9v6" />
                </>
            )}
            {status === "Completed" && <path d="m8.5 12 2.25 2.25 4.75-5" stroke="white" strokeWidth="2" />}
        </svg>
    );
}

function StatusMenu({
    status,
    onChange,
    highlighted = false,
    showLabel = false,
}: {
    status: string;
    onChange: (status: IssueStatus) => void;
    highlighted?: boolean;
    showLabel?: boolean;
}) {
    const [open, setOpen] = useState(false);

    return (
        <Select.Root
            onValueChange={(value) => {
                if (value) {
                    onChange(value as IssueStatus);
                    queueMicrotask(() => setOpen(false));
                }
            }}
            onOpenChange={setOpen}
            open={open}
            value={status}
        >
            <Select.Trigger
                aria-label={`Change status from ${status}`}
                className={`inline-flex items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    showLabel ? "gap-2 px-2 py-1" : "p-1"
                } ${highlighted ? `status-detail-trigger ${statusSurfaceClass(status)}` : ""}`}
                data-status-trigger
                onClick={() => setOpen(true)}
            >
                <StatusIcon className="size-5" status={status} />
                {showLabel && <span className="text-xs font-medium text-slate-600">{status}</span>}
            </Select.Trigger>
            <Select.Portal>
                <Select.Positioner
                    align="start"
                    alignItemWithTrigger={false}
                    className="z-[100020]"
                    side="bottom"
                    sideOffset={10}
                >
                    <Select.Popup className="surface-overlay min-w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl outline-none">
                        <Select.List>
                            {STATUSES.map((option) => (
                                <Select.Item className={menuItemClass} key={option} value={option}>
                                    <StatusIcon className="size-4" status={option} />
                                    <Select.ItemText>{option}</Select.ItemText>
                                    <Select.ItemIndicator className="ml-auto text-slate-500">
                                        <Icon className="size-3.5" name="check" />
                                    </Select.ItemIndicator>
                                </Select.Item>
                            ))}
                        </Select.List>
                    </Select.Popup>
                </Select.Positioner>
            </Select.Portal>
        </Select.Root>
    );
}

function formatDate(value: unknown) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
    }).format(date);
}

function formatIssueIdentifier(issueId: string) {
    return `ISS-${issueId.slice(0, 4).toUpperCase()}`;
}

function userName(user: User | undefined) {
    const name = [user?.givenName, user?.familyName].filter(Boolean).join(" ");
    return name || user?.email || user?.id || "Unknown user";
}

function userInitials(user: User | undefined) {
    const initials = [user?.givenName, user?.familyName]
        .filter(Boolean)
        .map((part) => part![0])
        .join("");
    return (initials || user?.email?.[0] || "?").toUpperCase();
}

function UserAvatar({
    user,
    ontology,
    className = "size-8",
}: {
    user?: User;
    ontology: TrackerOntology;
    className?: string;
}) {
    const [src, setSrc] = useState<string>();

    useEffect(() => {
        let active = true;
        let url: string | undefined;
        if (user?.avatar) {
            void ontology.attachments
                .blob(user.avatar)
                .then((blob) => {
                    if (blob.size === 0) {
                        if (active) {
                            setSrc(undefined);
                        }
                        return;
                    }
                    url = URL.createObjectURL(blob);
                    if (active) setSrc(url);
                })
                .catch(() => {
                    if (active) setSrc(undefined);
                });
        } else {
            setSrc(undefined);
        }
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [ontology, user?.avatar]);

    return (
        <span
            className={`${className} grid shrink-0 place-items-center overflow-hidden rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700`}
        >
            {src ? <img alt="" className="size-full object-cover" src={src} /> : userInitials(user)}
        </span>
    );
}

function useProfileUser(profile: ConnectedProfile): User | undefined {
    const ontology = profile.ontology;
    const { data: users } = useLiveQuery((q) => q.from({ User: ontology.objects.User }), [ontology]);
    return users.find((user) => user.id === ontology.context.user);
}

function ProfileIdentity({ profile }: { profile: ConnectedProfile }) {
    const user = useProfileUser(profile);
    return (
        <>
            <UserAvatar className="size-6" ontology={profile.ontology} user={user} />
            <span className="min-w-0 flex-1">
                <span className="block truncate">{user ? userName(user) : profile.label}</span>
                <span className="block truncate text-[11px] text-slate-400">
                    {user?.email ?? profile.label}
                </span>
            </span>
        </>
    );
}

const buttonClass =
    "surface-raised inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] font-medium text-slate-700 shadow-sm outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50";

const primaryButtonClass =
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[13px] font-medium text-white shadow-sm outline-none transition hover:bg-[#515cc2] focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50";

const menuItemClass =
    "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] text-slate-700 outline-none data-[highlighted]:bg-slate-100";

const dialogPopupClass =
    "surface-overlay relative w-[min(560px,calc(100vw-32px))] rounded-xl border border-slate-200 bg-white shadow-2xl outline-none";

function DialogFrame({ children }: { children: ReactNode }) {
    return (
        <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-[100010] bg-slate-950/25 backdrop-blur-[1px]" />
            <Dialog.Viewport className="fixed inset-0 z-[100011] grid place-items-center p-4">
                <Dialog.Popup className={dialogPopupClass}>{children}</Dialog.Popup>
            </Dialog.Viewport>
        </Dialog.Portal>
    );
}

function DeleteContextMenu({
    children,
    label,
    onDelete,
    className,
}: {
    children: ReactNode;
    label: string;
    onDelete: () => void;
    className?: string;
}) {
    return (
        <ContextMenu.Root>
            <ContextMenu.Trigger render={<div className={className} />}>{children}</ContextMenu.Trigger>
            <ContextMenu.Portal>
                <ContextMenu.Positioner className="z-[100020]">
                    <ContextMenu.Popup className="surface-overlay min-w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl outline-none">
                        <ContextMenu.Item className={`${menuItemClass} text-red-600`} onClick={onDelete}>
                            <Icon name="trash" />
                            Delete {label}
                        </ContextMenu.Item>
                    </ContextMenu.Popup>
                </ContextMenu.Positioner>
            </ContextMenu.Portal>
        </ContextMenu.Root>
    );
}

function ModalHeader({ title, description }: { title: string; description: string }) {
    return (
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
            <div>
                <Dialog.Title className="text-base font-semibold text-slate-900">{title}</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-sm text-slate-500">
                    {description}
                </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1.5 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-indigo-500">
                <Icon name="close" />
            </Dialog.Close>
        </div>
    );
}

function ProjectForm({
    project,
    onSave,
}: {
    project?: Project;
    onSave: (values: { title: string; description: string; color: string }) => void;
}) {
    const [title, setTitle] = useState(project?.projectTitle ?? "");
    const [description, setDescription] = useState(project?.projectDescription ?? "");
    const [color, setColor] = useState(project?.projectColor || PROJECT_COLORS[0]);
    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!title.trim()) return;
        onSave({
            title: title.trim(),
            description: description.trim(),
            color,
        });
    }

    return (
        <form onSubmit={handleSubmit}>
            <div className="space-y-4 px-5 py-5">
                <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">Project name</span>
                    <FormInput
                        autoFocus
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Website refresh"
                        value={title}
                    />
                </label>
                <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">Description</span>
                    <FormTextarea
                        className="min-h-20 resize-none"
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="What is this project about?"
                        value={description}
                    />
                </label>
                <div>
                    <span className="mb-2 block text-xs font-medium text-slate-600">Color</span>
                    <div className="flex gap-2">
                        {PROJECT_COLORS.map((option) => (
                            <button
                                aria-label={`Use ${option}`}
                                className="grid size-7 place-items-center rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-indigo-500"
                                key={option}
                                onClick={() => setColor(option)}
                                type="button"
                            >
                                <span
                                    className="grid size-5 place-items-center rounded-full text-white"
                                    style={{ backgroundColor: option }}
                                >
                                    {color === option && <Icon className="size-3" name="check" />}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
                <Dialog.Close className={buttonClass}>Cancel</Dialog.Close>
                <Button className={primaryButtonClass} disabled={!title.trim()} type="submit">
                    {project ? "Save changes" : "Create project"}
                </Button>
            </div>
        </form>
    );
}

type IssueAttachment = NonNullable<CreateIssueParameters["attachments"]>[number];

type PendingAttachment = {
    attachment: IssueAttachment;
    name: string;
};

function AttachmentPicker({
    actionType,
    attachments,
    onChange,
    ontology,
}: {
    actionType: "createIssue" | "updateIssue";
    attachments: PendingAttachment[];
    onChange: (attachments: PendingAttachment[]) => void;
    ontology: TrackerOntology;
}) {
    const [uploading, setUploading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    async function handleFiles(files: FileList | null) {
        if (!files?.length) return;
        setUploading(true);
        try {
            const additions = await Promise.all(
                Array.from(files).map(async (file) => {
                    const result = await ontology.attachments.create(file, {
                        target: {
                            kind: "actionParameter",
                            actionType,
                            parameter: "attachments",
                        },
                        eager: true,
                    });
                    if (result.isMaterialized) {
                        await result.isMaterialized;
                    }
                    return {
                        attachment: result.attachment,
                        name: file.name,
                    };
                })
            );
            onChange([...attachments, ...additions]);
        } finally {
            setUploading(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    }

    return (
        <div>
            <input
                accept="image/png,image/jpeg"
                className="sr-only"
                multiple
                onChange={(event) => void handleFiles(event.target.files)}
                ref={inputRef}
                type="file"
            />
            <Button
                className={buttonClass}
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
                type="button"
            >
                <Icon name="attachment" />
                {uploading ? "Uploading…" : "Attach files"}
            </Button>
            {attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {attachments.map((item, index) => (
                        <span
                            className="inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600"
                            key={`${item.attachment.id}-${index}`}
                        >
                            <span className="max-w-44 truncate">{item.name}</span>
                            <button
                                aria-label={`Remove ${item.name}`}
                                className="text-slate-400 hover:text-slate-700"
                                onClick={() =>
                                    onChange(attachments.filter((_, itemIndex) => itemIndex !== index))
                                }
                                type="button"
                            >
                                <Icon className="size-3" name="close" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function IssueForm({
    ontology,
    projects,
    users,
    initialProjectId,
    initialStatus,
    issue,
    onSave,
}: {
    ontology: TrackerOntology;
    projects: Project[];
    users: User[];
    initialProjectId?: string;
    initialStatus?: IssueStatus;
    issue?: Issue;
    onSave: (values: {
        title: string;
        description: string;
        status: IssueStatus;
        projectId?: string;
        assignee?: string;
        attachments: IssueAttachment[];
    }) => void;
}) {
    const [title, setTitle] = useState(issue?.issueTitle ?? "");
    const [description, setDescription] = useState(issue?.issueDescription ?? "");
    const [status, setStatus] = useState<IssueStatus>(
        (issue?.issueStatus as IssueStatus) ?? initialStatus ?? "Open"
    );
    const [projectId, setProjectId] = useState(issue?.projectId ?? initialProjectId ?? "");
    const [assignee, setAssignee] = useState(issue?.assignee ?? "");
    const [attachments, setAttachments] = useState<PendingAttachment[]>(
        (issue?.issueAttachments ?? []).map((attachment, index) => ({
            attachment,
            name: `Attachment ${index + 1}`,
        }))
    );
    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!title.trim()) return;
        onSave({
            title: title.trim(),
            description: description.trim(),
            status,
            projectId: projectId || undefined,
            assignee: assignee || undefined,
            attachments: attachments.map((item) => item.attachment),
        });
    }

    return (
        <form onSubmit={handleSubmit}>
            <div className="space-y-4 px-5 py-5">
                <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">Title</span>
                    <FormInput
                        autoFocus
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Issue title"
                        value={title}
                    />
                </label>
                <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">Description</span>
                    <FormTextarea
                        className="min-h-28 resize-y"
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="Add context, requirements, or notes…"
                        value={description}
                    />
                </label>
                <div className="grid grid-cols-3 gap-3">
                    <label>
                        <span className="mb-1.5 block text-xs font-medium text-slate-600">Status</span>
                        <FormSelect
                            onChange={(event) => setStatus(event.target.value as IssueStatus)}
                            value={status}
                        >
                            {STATUSES.map((option) => (
                                <option key={option}>{option}</option>
                            ))}
                        </FormSelect>
                    </label>
                    <label>
                        <span className="mb-1.5 block text-xs font-medium text-slate-600">Project</span>
                        <FormSelect onChange={(event) => setProjectId(event.target.value)} value={projectId}>
                            <option value="">No project</option>
                            {projects.map((project) => (
                                <option key={project.projectId} value={project.projectId}>
                                    {project.projectTitle}
                                </option>
                            ))}
                        </FormSelect>
                    </label>
                    <label>
                        <span className="mb-1.5 block text-xs font-medium text-slate-600">Assignee</span>
                        <FormSelect onChange={(event) => setAssignee(event.target.value)} value={assignee}>
                            <option value="">Unassigned</option>
                            {users.map((user) => (
                                <option key={user.id} value={user.id}>
                                    {userName(user)}
                                </option>
                            ))}
                        </FormSelect>
                    </label>
                </div>
                <AttachmentPicker
                    actionType={issue ? "updateIssue" : "createIssue"}
                    attachments={attachments}
                    onChange={setAttachments}
                    ontology={ontology}
                />
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
                <Dialog.Close className={buttonClass}>Cancel</Dialog.Close>
                <Button className={primaryButtonClass} disabled={!title.trim()} type="submit">
                    {issue ? "Save issue" : "Create issue"}
                </Button>
            </div>
        </form>
    );
}

function AttachmentCard({
    attachment,
    ontology,
}: {
    attachment: IssueAttachment;
    ontology: TrackerOntology;
}) {
    const [preview, setPreview] = useState<{
        url: string;
        metadata: AttachmentMetadata;
    }>();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let active = true;
        let url: string | undefined;
        void Promise.all([ontology.attachments.blob(attachment), ontology.attachments.metadata(attachment)])
            .then(([blob, metadata]) => {
                url = URL.createObjectURL(blob);
                if (active) setPreview({ url, metadata });
            })
            .catch(() => {
                if (active) setFailed(true);
            });
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [attachment, ontology]);

    if (failed) {
        return (
            <div className="rounded-lg border border-red-100 bg-red-50 p-3 text-xs text-red-600">
                Attachment unavailable
            </div>
        );
    }

    if (!preview) {
        return <div className="h-16 animate-pulse rounded-lg bg-slate-100" />;
    }

    const isImage = preview.metadata.type?.startsWith("image/");
    if (isImage) {
        const label = preview.metadata.name ?? "Issue attachment";
        return (
            <Dialog.Root>
                <Dialog.Trigger className="surface-raised group block w-full overflow-hidden rounded-lg border border-slate-200 bg-white outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    <img
                        alt={label}
                        className="max-h-52 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        src={preview.url}
                    />
                </Dialog.Trigger>
                <Dialog.Portal>
                    <Dialog.Backdrop className="fixed inset-0 z-[100030] bg-slate-950/80 backdrop-blur-sm" />
                    <Dialog.Viewport className="fixed inset-0 z-[100031] grid place-items-center p-6">
                        <Dialog.Popup className="surface-overlay relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-2 shadow-2xl outline-none">
                            <Dialog.Title className="sr-only">{label}</Dialog.Title>
                            <img
                                alt={label}
                                className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain"
                                src={preview.url}
                            />
                            <Dialog.Close className="absolute right-4 top-4 grid size-8 place-items-center rounded-md bg-slate-950/80 text-white outline-none backdrop-blur hover:bg-slate-900 focus-visible:ring-2 focus-visible:ring-white">
                                <Icon name="close" />
                            </Dialog.Close>
                        </Dialog.Popup>
                    </Dialog.Viewport>
                </Dialog.Portal>
            </Dialog.Root>
        );
    }

    return (
        <a
            className="surface-raised group block overflow-hidden rounded-lg border border-slate-200 bg-white"
            download={preview.metadata.name}
            href={preview.url}
        >
            <div className="flex items-center gap-3 p-3">
                <span className="grid size-9 place-items-center rounded-md bg-slate-100 text-slate-500">
                    <Icon name="attachment" />
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-700 group-hover:text-indigo-600">
                        {preview.metadata.name ?? "Attachment"}
                    </span>
                    <span className="text-xs text-slate-400">{preview.metadata.type ?? "File"}</span>
                </span>
            </div>
        </a>
    );
}

function IssueDetails({
    issueId,
    ontology,
    projects,
    users,
    onClose,
}: {
    issueId: string;
    ontology: TrackerOntology;
    projects: Project[];
    users: User[];
    onClose: () => void;
}) {
    const { updateIssue, deleteIssue } = ontology.actions;
    const [editing, setEditing] = useState(false);
    const { data: issue } = useLiveQuery(
        (q) =>
            q
                .from({ Issue: ontology.objects.Issue })
                .where(({ Issue }) => eq(Issue.issueId, issueId))
                .findOne(),
        [issueId]
    );

    if (!issue) {
        return <div className="p-8 text-center text-sm text-slate-500">Loading issue…</div>;
    }

    const project = projects.find((item) => item.projectId === issue.projectId);
    const assignee = users.find((user) => user.id === issue.assignee);
    const creator = users.find((user) => user.id === issue.createdBy);

    function saveIssue(values: {
        title: string;
        description: string;
        status: IssueStatus;
        projectId?: string;
        assignee?: string;
        attachments: IssueAttachment[];
    }) {
        const parameters: UpdateIssueParameters = {
            issue: issue!.issueId,
            title: values.title,
            description: values.description || null,
            status: values.status,
            project: values.projectId || null,
            assignee: values.assignee || null,
            attachments: values.attachments,
            completedAt:
                values.status === "Completed" ? issue!.issueCompletedAt || Temporal.Now.instant() : null,
        };
        void updateIssue(parameters).catch((error: unknown) => {
            console.error("Failed to update issue", error);
        });
        setEditing(false);
    }

    return (
        <div className="flex max-h-[min(760px,calc(100vh-32px))] flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 px-4">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                    {project && (
                        <>
                            <span
                                className="size-2 rounded-sm"
                                style={{
                                    backgroundColor: project.projectColor || "#94a3b8",
                                }}
                            />
                            <span>{project.projectTitle}</span>
                            <Icon className="size-3" name="chevron" />
                        </>
                    )}
                    <span className="font-mono">{formatIssueIdentifier(issue.issueId)}</span>
                </div>
                <div className="flex items-center gap-1">
                    <Button className={buttonClass} onClick={() => setEditing(true)}>
                        Edit
                    </Button>
                    <Menu.Root>
                        <Menu.Trigger
                            aria-label="Issue actions"
                            className="grid size-8 place-items-center rounded-md text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                            <Icon name="dots" />
                        </Menu.Trigger>
                        <Menu.Portal>
                            <Menu.Positioner align="end" className="z-[100020]" sideOffset={6}>
                                <Menu.Popup className="surface-overlay min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-xl outline-none">
                                    <Menu.Item
                                        className={`${menuItemClass} text-red-600`}
                                        onClick={() => {
                                            void deleteIssue({
                                                issue: issue.issueId,
                                            });
                                            onClose();
                                        }}
                                    >
                                        <Icon name="trash" />
                                        Delete issue
                                    </Menu.Item>
                                </Menu.Popup>
                            </Menu.Positioner>
                        </Menu.Portal>
                    </Menu.Root>
                    <Dialog.Close className="grid size-8 place-items-center rounded-md text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-indigo-500">
                        <Icon name="close" />
                    </Dialog.Close>
                </div>
            </div>
            <div className="overflow-y-auto px-7 py-6">
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">{issue.issueTitle}</h2>
                <div className="mt-3">
                    <StatusMenu
                        highlighted
                        onChange={(status) =>
                            saveIssue({
                                title: issue.issueTitle,
                                description: issue.issueDescription ?? "",
                                status,
                                projectId: issue.projectId || undefined,
                                assignee: issue.assignee || undefined,
                                attachments: issue.issueAttachments ?? [],
                            })
                        }
                        showLabel
                        status={issue.issueStatus}
                    />
                </div>
                <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                    {issue.issueDescription || "No description yet."}
                </p>
                <div className="mt-5 flex flex-wrap gap-4">
                    {[
                        ["Assignee", assignee],
                        ["Created by", creator],
                    ].map(([label, user]) => (
                        <div className="flex items-center gap-2" key={label as string}>
                            <UserAvatar
                                className="size-7"
                                ontology={ontology}
                                user={user as User | undefined}
                            />
                            <span>
                                <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                    {label as string}
                                </span>
                                <span className="block text-xs font-medium text-slate-700">
                                    {userName(user as User | undefined)}
                                </span>
                            </span>
                        </div>
                    ))}
                </div>
                <div className="mt-8">
                    <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <Icon name="attachment" />
                        Attachments
                        <span className="font-normal">{issue.issueAttachments?.length ?? 0}</span>
                    </h3>
                    {issue.issueAttachments?.length ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            {issue.issueAttachments.map((attachment) => (
                                <AttachmentCard
                                    attachment={attachment}
                                    key={attachment.id}
                                    ontology={ontology}
                                />
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-slate-400">No files attached.</p>
                    )}
                </div>
                <p className="mt-8 text-xs text-slate-400">Updated {formatDate(issue.issueUpdatedAt)}</p>
            </div>
            <Dialog.Root onOpenChange={setEditing} open={editing}>
                <DialogFrame>
                    <ModalHeader
                        description="Update details, status, project, or files."
                        title="Edit issue"
                    />
                    <IssueForm
                        issue={issue}
                        onSave={saveIssue}
                        ontology={ontology}
                        projects={projects}
                        users={users}
                    />
                </DialogFrame>
            </Dialog.Root>
        </div>
    );
}

type IssueRow = Issue & {
    projectTitle?: string;
    projectColor?: string;
};

type CommandIssue = {
    issueId: string;
    issueTitle: string;
    issueStatus: string;
};

function KanbanCard({
    issue,
    onDelete,
    onOpen,
}: {
    issue: IssueRow;
    onDelete: () => void;
    onOpen: () => void;
}) {
    const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({
        id: issue.issueId,
        data: {
            status: issue.issueStatus,
        },
    });

    return (
        <DeleteContextMenu className="block" label="issue" onDelete={onDelete}>
            <article
                className={`surface-raised cursor-pointer rounded-lg border border-slate-200 bg-white p-3 shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    isDragging
                        ? "kanban-card-dragging z-20 opacity-80 shadow-lg will-change-transform"
                        : "hover:border-slate-300 hover:shadow"
                }`}
                onClick={onOpen}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen();
                    }
                }}
                ref={setNodeRef}
                role="button"
                style={{
                    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
                }}
                tabIndex={0}
            >
                <div className="flex items-start gap-2">
                    <button
                        aria-label={`Drag ${issue.issueTitle}`}
                        className="drag-handle mt-0.5 rounded bg-slate-100 p-1 text-slate-500 outline-none hover:bg-slate-200 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
                        onClick={(event) => event.stopPropagation()}
                        type="button"
                        {...attributes}
                        {...listeners}
                    >
                        <Icon className="size-3.5" name="grip" />
                    </button>
                    <div className="min-w-0 flex-1 text-left">
                        <p className="mb-1 font-mono text-[11px] text-slate-400">
                            {formatIssueIdentifier(issue.issueId)}
                        </p>
                        <h3
                            className={`text-sm font-medium leading-5 ${
                                issue.issueStatus === "Completed"
                                    ? "text-slate-400 line-through"
                                    : "text-slate-800"
                            }`}
                        >
                            {issue.issueTitle}
                        </h3>
                        {issue.issueDescription && (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                                {issue.issueDescription}
                            </p>
                        )}
                    </div>
                </div>
                <div className="mt-3 flex items-center gap-2 pl-7">
                    {issue.projectTitle && (
                        <span className="flex min-w-0 items-center gap-1.5 rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-500">
                            <span
                                className="size-1.5 shrink-0 rounded-sm"
                                style={{
                                    backgroundColor: issue.projectColor || "#94a3b8",
                                }}
                            />
                            <span className="truncate">{issue.projectTitle}</span>
                        </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                        {issue.issueAttachments?.length > 0 && (
                            <span className="flex items-center gap-1 text-[10px] text-slate-400">
                                <Icon className="size-3" name="attachment" />
                                {issue.issueAttachments.length}
                            </span>
                        )}
                        <span className="text-[10px] text-slate-400">{formatDate(issue.issueUpdatedAt)}</span>
                    </span>
                </div>
            </article>
        </DeleteContextMenu>
    );
}

function KanbanColumn({
    issues,
    label,
    onCreateIssue,
    onDeleteIssue,
    onOpenIssue,
    status,
}: {
    issues: IssueRow[];
    label: string;
    onCreateIssue: (status: IssueStatus) => void;
    onDeleteIssue: (issueId: string) => void;
    onOpenIssue: (issueId: string) => void;
    status: IssueStatus;
}) {
    const { isOver, setNodeRef } = useDroppable({ id: status });

    return (
        <section className="flex min-h-0 min-w-72 flex-1 flex-col">
            <div
                className={`status-section-header ${statusSurfaceClass(status)} mb-2 flex h-8 items-center gap-2 rounded-md px-2`}
            >
                <StatusIcon className="size-5" status={status} />
                <h2 className="text-[13px] font-medium text-slate-600">{label}</h2>
                <span className="text-[11px] text-slate-400">{issues.length}</span>
                <button
                    aria-label={`Create ${label} issue`}
                    className="status-add-button ml-auto grid size-6 place-items-center rounded text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    onClick={() => onCreateIssue(status)}
                    type="button"
                >
                    <Icon className="size-3.5" name="plus" />
                </button>
            </div>
            <div
                className={`surface-sunken min-h-32 flex-1 space-y-2 rounded-xl border p-2 transition ${
                    isOver ? "border-indigo-300 bg-indigo-50/70" : "border-transparent bg-slate-50/70"
                }`}
                ref={setNodeRef}
            >
                {issues.map((issue) => (
                    <KanbanCard
                        issue={issue}
                        key={issue.issueId}
                        onDelete={() => onDeleteIssue(issue.issueId)}
                        onOpen={() => onOpenIssue(issue.issueId)}
                    />
                ))}
                {issues.length === 0 && (
                    <p className="px-3 py-8 text-center text-xs text-slate-400">Drop issues here</p>
                )}
            </div>
        </section>
    );
}

function KanbanBoard({
    issues,
    onCreateIssue,
    onDeleteIssue,
    onOpenIssue,
    onStatusChange,
}: {
    issues: IssueRow[];
    onCreateIssue: (status: IssueStatus) => void;
    onDeleteIssue: (issueId: string) => void;
    onOpenIssue: (issueId: string) => void;
    onStatusChange: (issue: IssueRow, status: IssueStatus) => void;
}) {
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 6 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: kanbanKeyboardCoordinates,
        })
    );

    function handleDragEnd(event: DragEndEvent) {
        const overStatus = event.over?.id as IssueStatus | undefined;
        if (!overStatus || !STATUSES.includes(overStatus)) return;
        const issue = issues.find((candidate) => candidate.issueId === event.active.id);
        if (!issue || issue.issueStatus === overStatus) return;
        onStatusChange(issue, overStatus);
    }

    return (
        <DndContext
            autoScroll={false}
            collisionDetection={closestCorners}
            onDragEnd={handleDragEnd}
            sensors={sensors}
        >
            <div className="flex min-h-full gap-3 overflow-x-auto p-4">
                {ISSUE_SECTIONS.map((section) => (
                    <KanbanColumn
                        issues={issues.filter((issue) => issue.issueStatus === section.status)}
                        key={section.status}
                        label={section.label}
                        onCreateIssue={onCreateIssue}
                        onDeleteIssue={onDeleteIssue}
                        onOpenIssue={onOpenIssue}
                        status={section.status}
                    />
                ))}
            </div>
        </DndContext>
    );
}

function CommandPalette({
    issues,
    onCreateIssue,
    onCreateProject,
    onOpenIssue,
    onOpenProject,
    onOpenChange,
    onShowAllIssues,
    open,
    projects,
}: {
    issues: CommandIssue[];
    onCreateIssue: () => void;
    onCreateProject: () => void;
    onOpenIssue: (issueId: string) => void;
    onOpenProject: (projectId: string) => void;
    onOpenChange: (open: boolean) => void;
    onShowAllIssues: () => void;
    open: boolean;
    projects: Project[];
}) {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);

    const commands = useMemo(() => {
        const items: Array<{
            id: string;
            label: string;
            description: string;
            icon: ReactNode;
            run: () => void;
        }> = [
            {
                id: "create-issue",
                label: "Create issue",
                description: "Action · new task",
                icon: <Icon name="plus" />,
                run: onCreateIssue,
            },
            {
                id: "create-project",
                label: "Create project",
                description: "Action",
                icon: <Icon name="project" />,
                run: onCreateProject,
            },
            {
                id: "all-issues",
                label: "All issues",
                description: "Navigation",
                icon: <Icon name="inbox" />,
                run: onShowAllIssues,
            },
            ...projects.map((project) => ({
                id: `project-${project.projectId}`,
                label: project.projectTitle,
                description: "Project",
                icon: (
                    <span
                        className="size-2.5 rounded-sm"
                        style={{
                            backgroundColor: project.projectColor || "#94a3b8",
                        }}
                    />
                ),
                run: () => onOpenProject(project.projectId),
            })),
            ...issues.map((issue) => ({
                id: `issue-${issue.issueId}`,
                label: issue.issueTitle,
                description: `Issue · ${issue.issueStatus}`,
                icon: <StatusIcon className="size-4" status={issue.issueStatus} />,
                run: () => onOpenIssue(issue.issueId),
            })),
        ];
        const normalizedQuery = query.trim().toLowerCase();
        return normalizedQuery
            ? items.filter(
                  (item) =>
                      item.label.toLowerCase().includes(normalizedQuery) ||
                      item.description.toLowerCase().includes(normalizedQuery)
              )
            : items;
    }, [
        issues,
        onCreateIssue,
        onCreateProject,
        onOpenIssue,
        onOpenProject,
        onShowAllIssues,
        projects,
        query,
    ]);

    useEffect(() => {
        setSelectedIndex(0);
    }, [query]);

    useEffect(() => {
        if (!open) {
            setQuery("");
            setSelectedIndex(0);
        }
    }, [open]);

    function runCommand(command: (typeof commands)[number]) {
        onOpenChange(false);
        command.run();
    }

    return (
        <Dialog.Root onOpenChange={onOpenChange} open={open}>
            <Dialog.Portal>
                <Dialog.Backdrop className="fixed inset-0 z-[100010] bg-slate-950/30 backdrop-blur-[1px]" />
                <Dialog.Viewport className="fixed inset-0 z-[100011] flex justify-center p-4 pt-[12vh]">
                    <Dialog.Popup className="surface-overlay h-fit w-[min(640px,calc(100vw-32px))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl outline-none">
                        <Dialog.Title className="sr-only">Command menu</Dialog.Title>
                        <div className="flex items-center gap-3 border-b border-slate-100 px-4">
                            <Icon className="size-4 shrink-0 text-slate-400" name="search" />
                            <input
                                autoFocus
                                className="command-palette-input h-12 min-w-0 flex-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "ArrowDown") {
                                        event.preventDefault();
                                        setSelectedIndex((index) => Math.min(index + 1, commands.length - 1));
                                    } else if (event.key === "ArrowUp") {
                                        event.preventDefault();
                                        setSelectedIndex((index) => Math.max(index - 1, 0));
                                    } else if (event.key === "Enter" && commands[selectedIndex]) {
                                        event.preventDefault();
                                        runCommand(commands[selectedIndex]);
                                    }
                                }}
                                placeholder="Search issues, projects, or actions…"
                                value={query}
                            />
                            <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-400">
                                ESC
                            </kbd>
                        </div>
                        <div className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
                            {commands.length === 0 ? (
                                <p className="px-3 py-8 text-center text-sm text-slate-400">
                                    No matching resources or actions.
                                </p>
                            ) : (
                                commands.map((command, index) => (
                                    <button
                                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none ${
                                            index === selectedIndex ? "bg-slate-100" : "hover:bg-slate-50"
                                        }`}
                                        key={command.id}
                                        onClick={() => runCommand(command)}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        type="button"
                                    >
                                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-slate-50 text-slate-500">
                                            {command.icon}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium text-slate-800">
                                                {command.label}
                                            </span>
                                            <span className="block text-xs text-slate-400">
                                                {command.description}
                                            </span>
                                        </span>
                                        {index === selectedIndex && (
                                            <kbd className="text-[10px] text-slate-400">↵</kbd>
                                        )}
                                    </button>
                                ))
                            )}
                        </div>
                    </Dialog.Popup>
                </Dialog.Viewport>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function ConnectProfileDialog({
    connecting,
    error,
    onConnect,
}: {
    connecting: boolean;
    error?: string;
    onConnect: (kind: "sqlite" | "google" | "foundry", values: Record<string, string>) => Promise<void>;
}) {
    const [kind, setKind] = useState<"sqlite" | "google" | "foundry">("sqlite");

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<
            string,
            string
        >;
        void onConnect(kind, values);
    }

    return (
        <DialogFrame>
            <ModalHeader
                description="Each profile keeps its own authentication and data connection."
                title="Connect profile"
            />
            <form onSubmit={submit}>
                <div className="space-y-4 px-5 py-5">
                    <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-slate-600">Profile type</span>
                        <FormSelect
                            name="kind"
                            onChange={(event) =>
                                setKind(event.target.value as "sqlite" | "google" | "foundry")
                            }
                            value={kind}
                        >
                            <option value="sqlite">SQLite demo</option>
                            <option value="google">Google</option>
                            <option value="foundry">Foundry</option>
                        </FormSelect>
                    </label>
                    {kind === "sqlite" ? (
                        <>
                            <label className="block">
                                <span className="mb-1.5 block text-xs font-medium text-slate-600">Email</span>
                                <FormInput
                                    autoFocus
                                    defaultValue="ada@example.com"
                                    name="username"
                                    required
                                    type="email"
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1.5 block text-xs font-medium text-slate-600">
                                    Password
                                </span>
                                <FormInput defaultValue="ada" name="password" required type="password" />
                            </label>
                            <p className="text-xs text-slate-400">
                                Demo accounts: ada@example.com / ada or grace@example.com / grace.
                            </p>
                        </>
                    ) : kind === "foundry" ? (
                        <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600">
                            Continue to Foundry to choose and authenticate your account. Connection settings
                            are configured by this app.
                        </p>
                    ) : (
                        <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600">
                            Continue to Google to authenticate a Better Auth account for the local SQLite
                            backend.
                        </p>
                    )}
                    {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
                </div>
                <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
                    <Dialog.Close className={buttonClass}>Cancel</Dialog.Close>
                    <Button className={primaryButtonClass} disabled={connecting} type="submit">
                        {connecting ? "Connecting…" : "Connect"}
                    </Button>
                </div>
            </form>
        </DialogFrame>
    );
}

export function IssueTracker({ initialProjectId = "" }: { initialProjectId?: string }) {
    const [profiles, setProfiles] = useState<ConnectedProfile[]>(() => getIssueTrackerProfiles());

    if (profiles.length === 0) {
        return <InitialProfileConnection onConnected={(profile) => setProfiles([profile])} />;
    }

    return <ConnectedIssueTracker initialProfiles={profiles} initialProjectId={initialProjectId} />;
}

function InitialProfileConnection({ onConnected }: { onConnected: (profile: ConnectedProfile) => void }) {
    const [open, setOpen] = useState(true);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState<string>();

    async function connect(kind: "sqlite" | "google" | "foundry", values: Record<string, string>) {
        setConnecting(true);
        setError(undefined);
        try {
            if (kind === "google") {
                onConnected(await connectGoogleProfile());
                return;
            }
            onConnected(
                kind === "sqlite"
                    ? await connectSqliteProfile({
                          username: values.username!,
                          password: values.password!,
                      })
                    : await connectFoundryProfile()
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not connect this profile.");
        } finally {
            setConnecting(false);
        }
    }

    return (
        <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-white">
            <div className="text-center">
                <div className="mx-auto grid size-12 place-items-center rounded-xl bg-indigo-500">
                    <Icon className="size-6" name="issue" />
                </div>
                <h1 className="mt-4 text-lg font-semibold">Connect a profile</h1>
                <p className="mt-1 text-sm text-slate-400">Sign in to Foundry or the local SQLite demo.</p>
                <Button className={`${primaryButtonClass} mt-5`} onClick={() => setOpen(true)}>
                    <Icon name="plus" />
                    Connect profile
                </Button>
            </div>
            <Dialog.Root onOpenChange={setOpen} open={open}>
                <ConnectProfileDialog connecting={connecting} error={error} onConnect={connect} />
            </Dialog.Root>
        </main>
    );
}

function ConnectedIssueTracker({
    initialProjectId,
    initialProfiles,
}: {
    initialProjectId: string;
    initialProfiles: ConnectedProfile[];
}) {
    const [profiles, setProfiles] = useState<ConnectedProfile[]>(initialProfiles);
    const navigate = useNavigate();
    const [activeProfileId, setActiveProfileId] = useState(() => {
        if (typeof window === "undefined") return profiles[0]!.id;
        const stored = window.localStorage.getItem("issue-tracker-active-profile");
        return profiles.some((profile) => profile.id === stored) ? stored! : profiles[0]!.id;
    });
    const [profileDialogOpen, setProfileDialogOpen] = useState(false);
    const [profileMenuOpen, setProfileMenuOpen] = useState(false);
    const [signedOut, setSignedOut] = useState(false);
    const [profileError, setProfileError] = useState<string>();
    const [connectingProfile, setConnectingProfile] = useState(false);
    const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]!;
    const ontology = activeProfile.ontology;
    const { createIssue, deleteIssue, updateIssue, createProject, updateProject, deleteProject } =
        ontology.actions;
    const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
    const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");
    const [collapsedSections, setCollapsedSections] = useState<Set<IssueStatus>>(() => new Set());
    const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
    const [commandOpen, setCommandOpen] = useState(false);
    const [createIssueOpen, setCreateIssueOpen] = useState(false);
    const [createIssueStatus, setCreateIssueStatus] = useState<IssueStatus>("Open");
    const [createIssueFormKey, setCreateIssueFormKey] = useState(0);
    const [createProjectOpen, setCreateProjectOpen] = useState(false);
    const [editingProject, setEditingProject] = useState<Project | null>(null);

    useEffect(() => {
        window.localStorage.setItem("issue-tracker-active-profile", activeProfileId);
    }, [activeProfileId]);

    useEffect(() => {
        const unsubscribes = profiles.map((profile) =>
            subscribeProfileConnection(profile, (state) => {
                if (state.status !== "needs-auth") {
                    return;
                }
                setProfileError(state.error ?? "Authentication is required.");
                setProfiles((current) => {
                    const remaining = current.filter((candidate) => candidate.id !== profile.id);
                    if (profile.id === activeProfileId) {
                        if (remaining.length === 0) {
                            setSignedOut(true);
                        } else {
                            setActiveProfileId(remaining[0]!.id);
                        }
                    }
                    return remaining;
                });
            })
        );
        return () => {
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        };
    }, [activeProfileId, profiles]);

    useEffect(() => {
        setSelectedProjectId(initialProjectId);
    }, [initialProjectId]);

    async function connectProfile(kind: "sqlite" | "google" | "foundry", values: Record<string, string>) {
        setConnectingProfile(true);
        setProfileError(undefined);
        try {
            if (kind === "google") {
                const profile = await connectGoogleProfile();
                setProfiles((current) => (signedOut ? [profile] : [...current, profile]));
                setActiveProfileId(profile.id);
                setSignedOut(false);
                setSelectedIssueId(null);
                setProfileDialogOpen(false);
                return;
            }
            const profile =
                kind === "sqlite"
                    ? await connectSqliteProfile({
                          username: values.username!,
                          password: values.password!,
                      })
                    : await connectFoundryProfile();
            setProfiles((current) => (signedOut ? [profile] : [...current, profile]));
            setActiveProfileId(profile.id);
            setSignedOut(false);
            setSelectedIssueId(null);
            setProfileDialogOpen(false);
        } catch (error) {
            setProfileError(error instanceof Error ? error.message : "Could not connect this profile.");
        } finally {
            setConnectingProfile(false);
        }
    }

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setCommandOpen((current) => !current);
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    const devtoolsPlugin = useMemo(() => createOntologyDevtoolsPlugin({ ontology }), [ontology]);

    const { data: projects, isLoading: projectsLoading } = useLiveQuery(
        (q) =>
            q
                .from({ Project: ontology.objects.Project })
                .orderBy(({ Project }) => Project.projectTitle, "asc"),
        [ontology]
    );

    const { data: users } = useLiveQuery(
        (q) => q.from({ User: ontology.objects.User }).orderBy(({ User }) => User.familyName, "asc"),
        [ontology]
    );
    const currentUser = users.find((user) => user.id === ontology.context.user);

    const { data: allIssueIds } = useLiveQuery(
        (q) =>
            q.from({ Issue: ontology.objects.Issue }).select(({ Issue }) => ({
                issueId: Issue.issueId,
            })),
        [ontology]
    );

    const { data: issues, isLoading: issuesLoading } = useLiveQuery(
        (q) =>
            q
                .from({ Issue: ontology.objects.Issue })
                .where(({ Issue }) => ilike(Issue.issueTitle, `${search}%`))
                .where(({ Issue }) =>
                    selectedProjectId ? eq(Issue.projectId, selectedProjectId) : ilike(Issue.issueTitle, "%")
                )
                .where(({ Issue }) =>
                    statusFilter !== "All"
                        ? eq(Issue.issueStatus, statusFilter)
                        : ilike(Issue.issueStatus, "%")
                )
                .leftJoin({ Project: ontology.objects.Project }, ({ Issue, Project }) =>
                    eq(Issue.projectId, Project.projectId)
                )
                .select(({ Issue, Project }) => ({
                    issueId: Issue.issueId,
                    issueTitle: Issue.issueTitle,
                    issueDescription: Issue.issueDescription,
                    issueStatus: Issue.issueStatus,
                    issueUpdatedAt: Issue.issueUpdatedAt,
                    issueCreatedAt: Issue.issueCreatedAt,
                    issueCompletedAt: Issue.issueCompletedAt,
                    createdBy: Issue.createdBy,
                    assignee: Issue.assignee,
                    issueAttachments: Issue.issueAttachments,
                    projectId: Issue.projectId,
                    projectTitle: Project.projectTitle,
                    projectColor: Project.projectColor,
                }))
                .orderBy(({ Issue }) => Issue.issueUpdatedAt, "desc"),
        [ontology, search, selectedProjectId, statusFilter]
    );

    const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
    const issueSections = useMemo(
        () =>
            ISSUE_SECTIONS.map((section) => ({
                ...section,
                issues: issues.filter((issue) => issue.issueStatus === section.status),
            })).filter((section) => section.issues.length > 0 || (!search && statusFilter === "All")),
        [issues, search, statusFilter]
    );

    function openProject(projectId: string) {
        setSelectedProjectId(projectId);
        void navigate({
            to: "/project/$projectId",
            params: { projectId },
        });
    }

    function showAllIssues() {
        setSelectedProjectId("");
        void navigate({ to: "/" });
    }

    function openCreateIssue(status: IssueStatus = "Open") {
        setCreateIssueStatus(status);
        setCreateIssueFormKey((current) => current + 1);
        setCreateIssueOpen(true);
    }

    function saveNewIssue(values: {
        title: string;
        description: string;
        status: IssueStatus;
        projectId?: string;
        assignee?: string;
        attachments: IssueAttachment[];
    }) {
        void createIssue({
            title: values.title,
            description: values.description || null,
            status: values.status,
            project: values.projectId || null,
            assignee: values.assignee || null,
            attachments: values.attachments,
            completedAt: values.status === "Completed" ? Temporal.Now.instant() : null,
        }).catch((error: unknown) => {
            console.error("Failed to create issue", error);
        });
        setCreateIssueOpen(false);
    }

    function changeIssueStatus(issue: IssueRow, status: IssueStatus) {
        void updateIssue({
            issue: issue.issueId,
            title: issue.issueTitle,
            description: issue.issueDescription || null,
            status,
            project: issue.projectId || null,
            assignee: issue.assignee || null,
            attachments: issue.issueAttachments ?? [],
            completedAt: status === "Completed" ? issue.issueCompletedAt || Temporal.Now.instant() : null,
        }).catch((error: unknown) => {
            console.error("Failed to update issue status", error);
        });
    }

    function toggleIssueSection(status: IssueStatus) {
        setCollapsedSections((current) => {
            const next = new Set(current);
            if (next.has(status)) {
                next.delete(status);
            } else {
                next.add(status);
            }
            return next;
        });
    }

    if (signedOut) {
        return (
            <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-center text-white">
                <div>
                    <div className="mx-auto grid size-12 place-items-center rounded-xl bg-indigo-500">
                        <Icon className="size-6" name="issue" />
                    </div>
                    <h1 className="mt-4 text-lg font-semibold">Connect a profile</h1>
                    <p className="mt-1 text-sm text-slate-400">
                        Sign in to Foundry or the local SQLite demo.
                    </p>
                    <Button
                        className={`${primaryButtonClass} mt-5`}
                        onClick={() => setProfileDialogOpen(true)}
                    >
                        <Icon name="plus" />
                        Connect profile
                    </Button>
                </div>
                <Dialog.Root onOpenChange={setProfileDialogOpen} open={profileDialogOpen}>
                    <ConnectProfileDialog
                        connecting={connectingProfile}
                        error={profileError}
                        onConnect={connectProfile}
                    />
                </Dialog.Root>
            </main>
        );
    }

    return (
        <Tooltip.Provider>
            <div className="surface-sunken flex h-screen min-h-[560px] overflow-hidden bg-white text-slate-900">
                <aside className="surface-sunken flex w-64 shrink-0 flex-col bg-[#f7f7f8]">
                    <div className="flex h-14 items-center gap-2 px-3">
                        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-[#5e6ad2] text-white">
                            <Icon className="size-4" name="issue" />
                        </div>
                        <span className="shrink-0 whitespace-nowrap text-sm font-semibold">
                            Issue tracker
                        </span>
                    </div>
                    <nav className="px-2">
                        <button
                            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                                !selectedProjectId
                                    ? "bg-slate-200/70 font-medium text-slate-900"
                                    : "text-slate-600 hover:bg-slate-200/60"
                            }`}
                            onClick={showAllIssues}
                            type="button"
                        >
                            <Icon name="inbox" />
                            All issues
                            <span className="ml-auto text-xs text-slate-400">{allIssueIds.length}</span>
                        </button>
                    </nav>
                    <div className="mt-5 flex items-center justify-between px-4">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Projects
                        </span>
                        <Tooltip.Root>
                            <Tooltip.Trigger
                                aria-label="Create project"
                                className="rounded p-0.5 text-slate-400 outline-none hover:bg-slate-200 hover:text-slate-700"
                                onClick={() => setCreateProjectOpen(true)}
                            >
                                <Icon className="size-3.5" name="plus" />
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                                <Tooltip.Positioner className="z-50" sideOffset={5}>
                                    <Tooltip.Popup className="rounded bg-slate-900 px-2 py-1 text-xs text-white shadow-lg">
                                        New project
                                    </Tooltip.Popup>
                                </Tooltip.Positioner>
                            </Tooltip.Portal>
                        </Tooltip.Root>
                    </div>
                    <div className="mt-1 space-y-0.5 overflow-y-auto px-2">
                        {projectsLoading ? (
                            <p className="px-2 py-2 text-xs text-slate-400">Loading projects…</p>
                        ) : (
                            projects.map((project) => (
                                <DeleteContextMenu
                                    className="group flex items-center"
                                    key={project.projectId}
                                    label="project"
                                    onDelete={() => {
                                        void deleteProject({
                                            project: project.projectId,
                                        });
                                        if (selectedProjectId === project.projectId) {
                                            showAllIssues();
                                        }
                                    }}
                                >
                                    <button
                                        className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                                            selectedProjectId === project.projectId
                                                ? "bg-slate-200/70 font-medium"
                                                : "text-slate-600 hover:bg-slate-200/60"
                                        }`}
                                        onClick={() => openProject(project.projectId)}
                                        type="button"
                                    >
                                        <span
                                            className="size-2.5 shrink-0 rounded-sm"
                                            style={{ backgroundColor: project.projectColor || "#94a3b8" }}
                                        />
                                        <span className="truncate">{project.projectTitle}</span>
                                    </button>
                                    <Menu.Root>
                                        <Menu.Trigger
                                            aria-label={`${project.projectTitle} actions`}
                                            className="-ml-7 mr-1 hidden size-6 place-items-center rounded text-slate-400 outline-none hover:bg-slate-300/60 group-hover:grid data-[popup-open]:grid"
                                        >
                                            <Icon className="size-3.5" name="dots" />
                                        </Menu.Trigger>
                                        <Menu.Portal>
                                            <Menu.Positioner className="z-40" sideOffset={4}>
                                                <Menu.Popup className="surface-overlay min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-xl outline-none">
                                                    <Menu.Item
                                                        className={menuItemClass}
                                                        onClick={() => setEditingProject(project)}
                                                    >
                                                        Edit project
                                                    </Menu.Item>
                                                    <Menu.Item
                                                        className={`${menuItemClass} text-red-600`}
                                                        onClick={() => {
                                                            void deleteProject({
                                                                project: project.projectId,
                                                            });
                                                            if (selectedProjectId === project.projectId) {
                                                                showAllIssues();
                                                            }
                                                        }}
                                                    >
                                                        <Icon name="trash" />
                                                        Delete project
                                                    </Menu.Item>
                                                </Menu.Popup>
                                            </Menu.Positioner>
                                        </Menu.Portal>
                                    </Menu.Root>
                                </DeleteContextMenu>
                            ))
                        )}
                    </div>
                    <div className="mt-auto px-2 pb-3">
                        <Menu.Root onOpenChange={setProfileMenuOpen} open={profileMenuOpen}>
                            <Menu.Trigger
                                className="flex w-full items-center gap-2 rounded-lg p-2 text-left outline-none hover:bg-slate-200/30 focus-visible:ring-2 focus-visible:ring-indigo-500"
                                onClick={() => setProfileMenuOpen(true)}
                            >
                                <UserAvatar ontology={ontology} user={currentUser} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-semibold text-slate-700">
                                        {userName(currentUser)}
                                    </span>
                                    <span className="block truncate text-[11px] text-slate-400">
                                        {currentUser?.email ?? activeProfile.label}
                                    </span>
                                </span>
                                <Icon className="size-3 text-slate-400" name="chevron" />
                            </Menu.Trigger>
                            <Menu.Portal>
                                <Menu.Positioner
                                    align="start"
                                    className="z-[100020]"
                                    side="top"
                                    sideOffset={8}
                                >
                                    <Menu.Popup className="surface-overlay w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl outline-none">
                                        <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                            Connected profiles
                                        </p>
                                        {profiles.map((profile) => (
                                            <Menu.Item
                                                className={`${menuItemClass} h-auto py-1.5`}
                                                key={profile.id}
                                                onClick={() => {
                                                    setSelectedIssueId(null);
                                                    showAllIssues();
                                                    setActiveProfileId(profile.id);
                                                    setProfileMenuOpen(false);
                                                }}
                                            >
                                                <ProfileIdentity profile={profile} />
                                                {profile.id === activeProfile.id && (
                                                    <Icon className="size-3.5 text-indigo-500" name="check" />
                                                )}
                                            </Menu.Item>
                                        ))}
                                        <Menu.Separator className="my-1 h-px bg-slate-100" />
                                        <Menu.Item
                                            className={menuItemClass}
                                            onClick={() => {
                                                setProfileMenuOpen(false);
                                                setProfileDialogOpen(true);
                                            }}
                                        >
                                            <Icon name="plus" />
                                            Connect another profile
                                        </Menu.Item>
                                        <Menu.Item
                                            className={`${menuItemClass} text-red-600`}
                                            onClick={() => {
                                                void disconnectProfile(activeProfile);
                                                if (profiles.length === 1) {
                                                    setProfileMenuOpen(false);
                                                    setSignedOut(true);
                                                    setProfileDialogOpen(true);
                                                    return;
                                                }
                                                const remaining = profiles.filter(
                                                    (profile) => profile.id !== activeProfile.id
                                                );
                                                setProfiles(remaining);
                                                setActiveProfileId(remaining[0]!.id);
                                            }}
                                        >
                                            Log out of{" "}
                                            {currentUser ? userName(currentUser) : activeProfile.label}
                                        </Menu.Item>
                                    </Menu.Popup>
                                </Menu.Positioner>
                            </Menu.Portal>
                        </Menu.Root>
                    </div>
                </aside>

                <main className="surface-base my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-100">
                    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-100 px-5">
                        <div className="flex min-w-0 items-center gap-2">
                            {selectedProject ? (
                                <>
                                    <span
                                        className="size-3 rounded-sm"
                                        style={{ backgroundColor: selectedProject.projectColor || "#94a3b8" }}
                                    />
                                    <h1 className="truncate text-sm font-semibold">
                                        {selectedProject.projectTitle}
                                    </h1>
                                </>
                            ) : (
                                <>
                                    <Icon className="size-4 text-slate-500" name="inbox" />
                                    <h1 className="text-sm font-semibold">All issues</h1>
                                </>
                            )}
                        </div>
                        <Button
                            aria-label="Open command menu"
                            className={`${buttonClass} ml-auto text-slate-500`}
                            onClick={() => setCommandOpen(true)}
                        >
                            <Icon name="search" />
                            <span className="hidden sm:inline">Search</span>
                            <kbd className="ml-1 text-[10px] text-slate-400">⌘K</kbd>
                        </Button>
                        <Button className={primaryButtonClass} onClick={() => openCreateIssue()}>
                            <Icon name="plus" />
                            New issue
                        </Button>
                    </header>
                    {selectedProject?.projectDescription && (
                        <div className="border-b border-slate-100 px-5 py-3 text-sm text-slate-500">
                            {selectedProject.projectDescription}
                        </div>
                    )}
                    <div className="flex h-12 shrink-0 items-center gap-2 px-3">
                        <div className="relative w-64">
                            <Icon className="absolute left-2.5 top-2 size-4 text-slate-400" name="search" />
                            <FormInput
                                aria-label="Search issues"
                                className="pl-8"
                                controlSize="compact"
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search issues…"
                                value={search}
                            />
                        </div>
                        <FormSelect
                            aria-label="Filter by status"
                            className="text-slate-600"
                            controlSize="compact"
                            fullWidth={false}
                            onChange={(event) => setStatusFilter(event.target.value)}
                            value={statusFilter}
                        >
                            <option>All</option>
                            {STATUSES.map((status) => (
                                <option key={status}>{status}</option>
                            ))}
                        </FormSelect>
                        <span className="ml-auto text-xs text-slate-400">
                            {issues.length} {issues.length === 1 ? "issue" : "issues"}
                        </span>
                        <ToggleGroup
                            aria-label="Issue view"
                            className="flex rounded-md border border-slate-200 bg-white p-0.5"
                            onValueChange={(values) => {
                                const next = values.at(-1);
                                if (next === "list" || next === "kanban") {
                                    setViewMode(next);
                                }
                            }}
                            value={[viewMode]}
                        >
                            <Toggle
                                aria-label="List view"
                                className="data-pressed:bg-slate-100 data-pressed:text-slate-700 grid size-6 place-items-center rounded text-slate-400 outline-none hover:text-slate-600"
                                value="list"
                            >
                                <Icon className="size-3.5" name="list" />
                            </Toggle>
                            <Toggle
                                aria-label="Kanban view"
                                className="data-pressed:bg-slate-100 data-pressed:text-slate-700 grid size-6 place-items-center rounded text-slate-400 outline-none hover:text-slate-600"
                                value="kanban"
                            >
                                <Icon className="size-3.5" name="kanban" />
                            </Toggle>
                        </ToggleGroup>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {issuesLoading ? (
                            <div className="grid h-full min-h-64 place-items-center p-8 text-center">
                                <div className="flex items-center gap-2 text-sm text-slate-400">
                                    <span className="size-3 animate-spin rounded-full border-2 border-slate-200 border-r-indigo-500" />
                                    Loading {activeProfile.label} issues…
                                </div>
                            </div>
                        ) : viewMode === "kanban" ? (
                            <KanbanBoard
                                issues={issues}
                                onCreateIssue={openCreateIssue}
                                onDeleteIssue={(issueId) => {
                                    void deleteIssue({
                                        issue: issueId,
                                    });
                                    if (selectedIssueId === issueId) {
                                        setSelectedIssueId(null);
                                    }
                                }}
                                onOpenIssue={setSelectedIssueId}
                                onStatusChange={changeIssueStatus}
                            />
                        ) : issues.length === 0 ? (
                            <div className="grid h-full min-h-64 place-items-center p-8 text-center">
                                <div>
                                    <div className="mx-auto grid size-10 place-items-center rounded-full bg-slate-100 text-slate-400">
                                        <Icon name="archive" />
                                    </div>
                                    <h2 className="mt-3 text-sm font-semibold text-slate-700">
                                        No issues found
                                    </h2>
                                    <p className="mt-1 text-sm text-slate-400">
                                        Create an issue or adjust your filters.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="pb-4">
                                {issueSections.map((section) => (
                                    <section className="py-1 first:pt-2" key={section.status}>
                                        <div
                                            className={`status-section-header status-section-toggle group ${statusSurfaceClass(section.status)} sticky top-1 z-10 mx-3 flex h-9 w-auto items-center rounded-lg backdrop-blur-sm`}
                                        >
                                            <button
                                                aria-expanded={!collapsedSections.has(section.status)}
                                                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                                                onClick={() => toggleIssueSection(section.status)}
                                                type="button"
                                            >
                                                <Icon
                                                    className={`size-3 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-slate-600 ${
                                                        collapsedSections.has(section.status)
                                                            ? ""
                                                            : "rotate-90"
                                                    }`}
                                                    name="chevron"
                                                />
                                                <StatusIcon className="size-5" status={section.status} />
                                                <h2 className="text-[13px] font-medium text-slate-600">
                                                    {section.label}
                                                </h2>
                                                <span className="text-[11px] text-slate-400">
                                                    {section.issues.length}
                                                </span>
                                            </button>
                                            <button
                                                aria-label={`Create ${section.label} issue`}
                                                className="status-add-button mr-3 grid size-6 shrink-0 place-items-center rounded text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                                onClick={() => openCreateIssue(section.status)}
                                                type="button"
                                            >
                                                <Icon className="size-3.5" name="plus" />
                                            </button>
                                        </div>
                                        {!collapsedSections.has(section.status) &&
                                            section.issues.map((issue) => (
                                                <div
                                                    className="group mx-3 flex min-h-12 w-auto cursor-pointer items-center gap-3 rounded-lg pl-10 pr-3 transition hover:bg-slate-50"
                                                    key={issue.issueId}
                                                    onClick={(event) => {
                                                        if (
                                                            event.target instanceof Element &&
                                                            event.target.closest(
                                                                "[data-status-trigger], [role='listbox'], [role='menu']"
                                                            )
                                                        ) {
                                                            return;
                                                        }
                                                        setSelectedIssueId(issue.issueId);
                                                    }}
                                                >
                                                    <span className="w-14 shrink-0 font-mono text-[10px] text-slate-400">
                                                        {formatIssueIdentifier(issue.issueId)}
                                                    </span>
                                                    <StatusMenu
                                                        onChange={(status) =>
                                                            changeIssueStatus(issue, status)
                                                        }
                                                        status={issue.issueStatus}
                                                    />
                                                    <DeleteContextMenu
                                                        className="contents"
                                                        label="issue"
                                                        onDelete={() => {
                                                            void deleteIssue({
                                                                issue: issue.issueId,
                                                            });
                                                            if (selectedIssueId === issue.issueId) {
                                                                setSelectedIssueId(null);
                                                            }
                                                        }}
                                                    >
                                                        <button
                                                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                                            onClick={() => setSelectedIssueId(issue.issueId)}
                                                            type="button"
                                                        >
                                                            <div className="min-w-0 flex-1 py-2.5">
                                                                <div className="flex items-center gap-2">
                                                                    <span
                                                                        className={`truncate text-[13px] font-medium ${issue.issueStatus === "Completed" ? "text-slate-400 line-through" : "text-slate-800"}`}
                                                                    >
                                                                        {issue.issueTitle}
                                                                    </span>
                                                                </div>
                                                                {issue.issueDescription && (
                                                                    <p className="mt-0.5 truncate text-xs text-slate-400">
                                                                        {issue.issueDescription}
                                                                    </p>
                                                                )}
                                                            </div>
                                                            {issue.issueAttachments?.length > 0 && (
                                                                <span className="flex items-center gap-1 text-xs text-slate-400">
                                                                    <Icon
                                                                        className="size-3.5"
                                                                        name="attachment"
                                                                    />
                                                                    {issue.issueAttachments.length}
                                                                </span>
                                                            )}
                                                            {issue.projectTitle && (
                                                                <span className="hidden max-w-32 items-center gap-1.5 truncate rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-500 sm:flex">
                                                                    <span
                                                                        className="size-1.5 shrink-0 rounded-sm"
                                                                        style={{
                                                                            backgroundColor:
                                                                                issue.projectColor ||
                                                                                "#94a3b8",
                                                                        }}
                                                                    />
                                                                    <span className="truncate">
                                                                        {issue.projectTitle}
                                                                    </span>
                                                                </span>
                                                            )}
                                                            <span className="w-12 text-right text-xs text-slate-400">
                                                                {formatDate(issue.issueUpdatedAt)}
                                                            </span>
                                                        </button>
                                                    </DeleteContextMenu>
                                                </div>
                                            ))}
                                    </section>
                                ))}
                            </div>
                        )}
                    </div>
                </main>

                <CommandPalette
                    issues={issues}
                    onCreateIssue={() => openCreateIssue()}
                    onCreateProject={() => setCreateProjectOpen(true)}
                    onOpenChange={setCommandOpen}
                    onOpenIssue={(issueId) => setSelectedIssueId(issueId)}
                    onOpenProject={openProject}
                    onShowAllIssues={showAllIssues}
                    open={commandOpen}
                    projects={projects}
                />

                <Dialog.Root
                    onOpenChange={(open) => {
                        setProfileDialogOpen(open);
                        if (!open) setProfileError(undefined);
                    }}
                    open={profileDialogOpen}
                >
                    <ConnectProfileDialog
                        connecting={connectingProfile}
                        error={profileError}
                        onConnect={connectProfile}
                    />
                </Dialog.Root>

                <Dialog.Root onOpenChange={setCreateIssueOpen} open={createIssueOpen}>
                    <DialogFrame>
                        <ModalHeader description="Track a new piece of work." title="Create issue" />
                        <IssueForm
                            initialProjectId={selectedProjectId}
                            initialStatus={createIssueStatus}
                            key={createIssueFormKey}
                            onSave={saveNewIssue}
                            ontology={ontology}
                            projects={projects}
                            users={users}
                        />
                    </DialogFrame>
                </Dialog.Root>

                <Dialog.Root onOpenChange={setCreateProjectOpen} open={createProjectOpen}>
                    <DialogFrame>
                        <ModalHeader
                            description="Group related issues around a shared objective."
                            title="Create project"
                        />
                        <ProjectForm
                            onSave={(values) => {
                                void createProject(values).catch((error: unknown) => {
                                    console.error("Failed to create project", error);
                                });
                                setCreateProjectOpen(false);
                            }}
                        />
                    </DialogFrame>
                </Dialog.Root>

                <Dialog.Root
                    onOpenChange={(open) => {
                        if (!open) setEditingProject(null);
                    }}
                    open={Boolean(editingProject)}
                >
                    <DialogFrame>
                        <ModalHeader
                            description="Change this project's name, description, or color."
                            title="Edit project"
                        />
                        {editingProject && (
                            <ProjectForm
                                project={editingProject}
                                onSave={(values) => {
                                    void updateProject({
                                        project: editingProject.projectId,
                                        ...values,
                                    }).catch((error: unknown) => {
                                        console.error("Failed to update project", error);
                                    });
                                    setEditingProject(null);
                                }}
                            />
                        )}
                    </DialogFrame>
                </Dialog.Root>

                <Dialog.Root
                    onOpenChange={(open) => {
                        if (!open) setSelectedIssueId(null);
                    }}
                    open={Boolean(selectedIssueId)}
                >
                    <DialogFrame>
                        {selectedIssueId && (
                            <IssueDetails
                                issueId={selectedIssueId}
                                onClose={() => setSelectedIssueId(null)}
                                ontology={ontology}
                                projects={projects}
                                users={users}
                            />
                        )}
                    </DialogFrame>
                </Dialog.Root>

                <TanStackDevtools
                    config={{ customTrigger: ontologyDevtoolsTrigger }}
                    plugins={[devtoolsPlugin]}
                />
            </div>
        </Tooltip.Provider>
    );
}
