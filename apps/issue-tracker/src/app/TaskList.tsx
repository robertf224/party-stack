"use client";

import { concat, eq, ilike, useLiveQuery } from "@tanstack/react-db";
import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ontology, User } from "./collections";
import { MiniMap } from "./MiniMap";
import { useAction } from "./useAction";
import type * as v from "@party-stack/ontology/values";

function withViewTransition(fn: () => void) {
    if (!document.startViewTransition) {
        fn();
        return;
    }
    document.startViewTransition(() => flushSync(fn));
}

function formatFileSize(size: number) {
    const kilobytes = size / 1024;
    if (kilobytes < 1024) {
        return `${Math.max(1, Math.round(kilobytes))} KB`;
    }
    return `${(kilobytes / 1024).toFixed(1)} MB`;
}

type SelectedTaskImage = {
    file: File;
    attachment?: v.attachment;
    status: "uploading" | "ready" | "deferred" | "failed";
    error?: string;
};

type AttachmentStatus = "loading" | "ready" | "deferred" | "uploading" | "failed";

function getAttachmentStatus(status: AttachmentStatus): {
    label: string;
    className: string;
    icon: "check" | "spinner" | "dot" | "x";
} {
    switch (status) {
        case "ready":
            return {
                label: "Image ready",
                className: "bg-emerald-500 text-white",
                icon: "check",
            };
        case "failed":
            return {
                label: "Attachment failed",
                className: "bg-red-500 text-white",
                icon: "x",
            };
        case "deferred":
            return {
                label: "Upload deferred",
                className: "bg-amber-400 text-amber-950",
                icon: "dot",
            };
        case "loading":
        case "uploading":
            return {
                label: status === "uploading" ? "Uploading attachment" : "Loading attachment",
                className: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
                icon: "spinner",
            };
    }
}

const AttachmentStatusBadge: React.FC<{
    status: AttachmentStatus;
    label?: string;
    showLabel?: boolean;
}> = ({ status, label, showLabel = false }) => {
    const meta = getAttachmentStatus(status);
    const accessibleLabel = label ?? meta.label;

    return (
        <span
            aria-label={accessibleLabel}
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium shadow-sm ${meta.className}`}
            title={accessibleLabel}
        >
            {meta.icon === "check" && (
                <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16">
                    <path
                        d="M13.5 4.5 6.75 11.25 3 7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                    />
                </svg>
            )}
            {meta.icon === "x" && (
                <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16">
                    <path
                        d="m4.5 4.5 7 7m0-7-7 7"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeWidth="2"
                    />
                </svg>
            )}
            {meta.icon === "spinner" && (
                <span
                    aria-hidden="true"
                    className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
                />
            )}
            {meta.icon === "dot" && (
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
            )}
            <span className={showLabel ? "" : "sr-only"}>{accessibleLabel}</span>
        </span>
    );
};

function useGeolocation() {
    const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);

    useEffect(() => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => {}
        );
    }, []);

    return coords;
}

const TaskAttachmentPreview: React.FC<{
    attachment: v.attachment;
}> = ({ attachment }) => {
    const [preview, setPreview] = useState<{
        metadata: Partial<v.attachment>;
        src: string;
    }>();
    const [status, setStatus] = useState<AttachmentStatus>("loading");

    useEffect(() => {
        const attachments = ontology.attachments;
        if (!attachments) {
            return;
        }

        let cancelled = false;
        let objectUrl: string | undefined;

        const releaseLease = attachments.lease(attachment);
        void Promise.all([attachments.metadata(attachment), attachments.blob(attachment)])
            .then(([metadata, blob]) => {
                const nextObjectUrl = URL.createObjectURL(blob);
                if (cancelled) {
                    URL.revokeObjectURL(nextObjectUrl);
                    return;
                }
                objectUrl = nextObjectUrl;
                setPreview({ metadata, src: nextObjectUrl });
                setStatus("ready");
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    console.error("Failed to load task attachment preview", error);
                    setPreview(undefined);
                    setStatus("failed");
                }
            });

        return () => {
            cancelled = true;
            releaseLease();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [attachment]);

    const attachmentMetadata = preview?.metadata ?? attachment;

    if (!preview?.src) {
        return (
            <div className="flex h-32 w-full items-end rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">
                <AttachmentStatusBadge status={status} />
            </div>
        );
    }

    return (
        <div className="relative">
            <img
                alt={attachmentMetadata.name ?? "Task attachment"}
                className="max-h-64 w-full rounded-lg border border-zinc-200 object-cover dark:border-zinc-800"
                src={preview.src}
            />
            <span className="absolute right-2 top-2">
                <AttachmentStatusBadge status={status} />
            </span>
        </div>
    );
};

export const TaskList: React.FC = () => {
    const [query, setQuery] = useState("");
    const [title, setTitle] = useState("");
    const [selectedImage, setSelectedImage] = useState<SelectedTaskImage | null>(null);
    const [eagerMaterialization, setEagerMaterialization] = useState(true);
    const [isImageDragActive, setIsImageDragActive] = useState(false);
    const imageUploadRequestId = useRef(0);
    const coords = useGeolocation();
    const createTask = useAction(ontology.actions.createTask);
    const deleteTask = useAction(ontology.actions.deleteTask);
    const completeTask = useAction(ontology.actions.completeTask);
    const reopenTask = useAction(ontology.actions.reopenTask);

    const { data: tasks } = useLiveQuery(
        (q) =>
            q
                .from({ Task: ontology.objects.Task })
                .where(({ Task }) => ilike(Task.title, `${query}%`))
                .innerJoin({ User }, ({ Task, User }) => eq(Task.createdBy, User.id))
                .select(({ Task, User }) => ({
                    id: Task.id,
                    title: Task.title,
                    createdBy: concat(User.givenName, " ", User.familyName),
                    createdAt: Task.createdAt,
                    completedAt: Task.completedAt,
                    location: Task.location,
                    attachments: Task.attachments,
                }))
                .orderBy(({ Task }) => Task.completedAt, "desc")
                .orderBy(({ Task }) => Task.createdAt, "asc")
                .limit(10),
        [query]
    );

    const handleCreateTask = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const nextTitle = title.trim();
        if (!nextTitle) {
            return;
        }

        if (selectedImage && !selectedImage.attachment) {
            return;
        }

        const attachments = selectedImage?.attachment ? [selectedImage.attachment] : undefined;

        withViewTransition(() => {
            setTitle("");
            setSelectedImage(null);
            createTask({ title: nextTitle, location: coords ?? undefined, attachments });
        });
    };

    const handleImageFile = (file: File | null) => {
        const requestId = imageUploadRequestId.current + 1;
        imageUploadRequestId.current = requestId;
        if (!file) {
            setSelectedImage(null);
            return;
        }
        if (!file.type.startsWith("image/")) {
            return;
        }
        setSelectedImage({ file, status: eagerMaterialization ? "uploading" : "deferred" });

        void ontology.attachments!
            .create(file, {
                target: { objectType: "Task", property: "attachments" },
                eager: eagerMaterialization,
            })
            .then((attachment) => {
                if (imageUploadRequestId.current !== requestId) {
                    return;
                }
                setSelectedImage({
                    file,
                    attachment,
                    status: eagerMaterialization ? "ready" : "deferred",
                });
            })
            .catch((error: unknown) => {
                if (imageUploadRequestId.current !== requestId) {
                    return;
                }
                setSelectedImage({
                    file,
                    status: "failed",
                    error: error instanceof Error ? error.message : "Upload failed",
                });
            });
    };

    const handleImageDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsImageDragActive(false);
        handleImageFile(event.dataTransfer.files[0] ?? null);
    };

    const handleImageDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
        }
        setIsImageDragActive(false);
    };

    const handleUseDemoPicture = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d");
        if (!context) {
            return;
        }

        context.fillStyle = "#0ea5e9";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#fef3c7";
        context.beginPath();
        context.arc(95, 82, 42, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "#082f49";
        context.lineWidth = 18;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(168, 128);
        context.bezierCurveTo(190, 76, 240, 76, 262, 128);
        context.stroke();
        context.fillStyle = "#082f49";
        context.font = "18px sans-serif";
        context.textAlign = "center";
        context.fillText("party-stack demo", 160, 160);

        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) {
            return;
        }
        handleImageFile(new File([blob], "demo-attachment.png", { type: "image/png" }));
    };

    const handleDeleteTask = (taskId: string) => {
        withViewTransition(() => {
            deleteTask({ task: taskId });
        });
    };

    const handleToggleTask = (taskId: string, completedAt: unknown) => {
        withViewTransition(() => {
            if (completedAt) {
                reopenTask({ task: taskId, completedAt: null });
                return;
            }
            completeTask({ task: taskId });
        });
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <main className="flex min-h-screen w-full max-w-3xl flex-col items-center gap-8 bg-white px-16 py-32 sm:items-start dark:bg-black">
                <section className="w-full max-w-xl rounded-2xl border border-zinc-200 bg-zinc-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="mb-4">
                        <h1 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">Create task</h1>
                        <p className="text-sm text-zinc-500 dark:text-zinc-400">
                            Add a task with an optional image and your current coordinates.
                        </p>
                    </div>
                    <form className="flex flex-col gap-4" onSubmit={handleCreateTask}>
                        <label className="flex flex-col gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                            Task title
                            <div className="flex gap-3">
                                <input
                                    className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-950 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-black dark:text-zinc-50"
                                    placeholder="Add a task..."
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                />
                                <button
                                    className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
                                    disabled={
                                        !title.trim() ||
                                        selectedImage?.status === "uploading" ||
                                        selectedImage?.status === "failed"
                                    }
                                    type="submit"
                                >
                                    Create
                                </button>
                            </div>
                        </label>
                        <div
                            className={`rounded-xl border border-dashed p-4 ${
                                isImageDragActive
                                    ? "border-zinc-900 bg-white ring-2 ring-zinc-900/10 dark:border-zinc-100 dark:bg-black dark:ring-zinc-100/20"
                                    : "border-zinc-300 bg-white/70 dark:border-zinc-700 dark:bg-black/50"
                            }`}
                            onDragEnter={(event) => {
                                event.preventDefault();
                                setIsImageDragActive(true);
                            }}
                            onDragLeave={handleImageDragLeave}
                            onDragOver={(event) => {
                                event.preventDefault();
                                setIsImageDragActive(true);
                            }}
                            onDrop={handleImageDrop}
                        >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                        Attach an image
                                    </p>
                                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                                        Drop an image here, browse your files, or use the demo image.
                                    </p>
                                    <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                                        <input
                                            checked={eagerMaterialization}
                                            className="h-3.5 w-3.5 rounded border-zinc-300"
                                            onChange={(event) =>
                                                setEagerMaterialization(event.target.checked)
                                            }
                                            type="checkbox"
                                        />
                                        Eagerly upload selected images
                                    </label>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <label className="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
                                        Browse
                                        <input
                                            accept="image/*"
                                            className="sr-only"
                                            onChange={(event) =>
                                                handleImageFile(event.target.files?.[0] ?? null)
                                            }
                                            type="file"
                                        />
                                    </label>
                                    <button
                                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                                        onClick={handleUseDemoPicture}
                                        type="button"
                                    >
                                        Use demo
                                    </button>
                                </div>
                            </div>
                            {selectedImage && (
                                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                                    <div className="min-w-0">
                                        <p className="truncate">
                                            Will attach {selectedImage.file.name} (
                                            {formatFileSize(selectedImage.file.size)})
                                        </p>
                                        <div className="mt-1 flex items-center gap-2">
                                            <AttachmentStatusBadge
                                                showLabel
                                                status={
                                                    selectedImage.status === "ready"
                                                        ? "ready"
                                                        : selectedImage.status
                                                }
                                            />
                                            {selectedImage.status === "failed" && selectedImage.error && (
                                                <span className="text-xs text-red-600 dark:text-red-400">
                                                    {selectedImage.error}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        className="shrink-0 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                                        onClick={() => {
                                            imageUploadRequestId.current += 1;
                                            setSelectedImage(null);
                                        }}
                                        type="button"
                                    >
                                        Remove
                                    </button>
                                </div>
                            )}
                        </div>
                    </form>
                </section>
                <section className="w-full max-w-xl">
                    <label className="flex flex-col gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        Search tasks
                        <input
                            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-950 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                            placeholder="Search by title..."
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </label>
                </section>
                <ul className="flex w-full max-w-xl flex-col gap-4">
                    {tasks.map((task) => (
                        <li
                            key={task.id}
                            className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                            style={{ viewTransitionName: `task-${task.id}` }}
                        >
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                    <input
                                        checked={Boolean(task.completedAt)}
                                        className="mt-1 h-4 w-4 rounded border-zinc-300"
                                        onChange={() => handleToggleTask(task.id, task.completedAt)}
                                        type="checkbox"
                                    />
                                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                                        <h2
                                            className={`truncate text-base font-semibold ${
                                                task.completedAt
                                                    ? "text-zinc-500 line-through dark:text-zinc-500"
                                                    : "text-zinc-900 dark:text-zinc-100"
                                            }`}
                                        >
                                            {task.title}{" "}
                                            <span className="text-gray-500">
                                                {task.createdAt?.toLocaleString()}
                                            </span>
                                        </h2>
                                        <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                            Created by {task.createdBy}
                                        </p>
                                        {task.completedAt && (
                                            <p className="text-xs text-zinc-500 dark:text-zinc-500">
                                                Completed {String(task.completedAt)}
                                            </p>
                                        )}
                                        {task.location && (
                                            <MiniMap lat={task.location.lat} lon={task.location.lon} />
                                        )}
                                        {task.attachments?.[0]?.id && (
                                            <TaskAttachmentPreview
                                                key={task.attachments[0].id}
                                                attachment={task.attachments[0]}
                                            />
                                        )}
                                    </div>
                                </div>
                                <button
                                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
                                    onClick={() => handleDeleteTask(task.id)}
                                    type="button"
                                >
                                    Delete
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            </main>
        </div>
    );
};
