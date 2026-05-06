"use client";

import { concat, eq, ilike, useLiveQuery } from "@tanstack/react-db";
import React, { useEffect, useState } from "react";
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

    useEffect(() => {
        const attachments = ontology.attachments;
        if (!attachments) {
            return;
        }

        let cancelled = false;
        let objectUrl: string | undefined;

        attachments.retain(attachment);
        void Promise.all([attachments.metadata(attachment), attachments.blob(attachment)])
            .then(([metadata, blob]) => {
                const nextObjectUrl = URL.createObjectURL(blob);
                if (cancelled) {
                    URL.revokeObjectURL(nextObjectUrl);
                    return;
                }
                objectUrl = nextObjectUrl;
                setPreview({ metadata, src: nextObjectUrl });
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    console.error("Failed to load task attachment preview", error);
                    setPreview(undefined);
                }
            });

        return () => {
            cancelled = true;
            attachments.release(attachment);
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [attachment]);

    const attachmentMetadata = preview?.metadata ?? attachment;

    if (!preview?.src) {
        return (
            <div className="h-32 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />
        );
    }

    return (
        <img
            alt={attachmentMetadata.name ?? "Task attachment"}
            className="max-h-64 w-full rounded-lg border border-zinc-200 object-cover dark:border-zinc-800"
            src={preview.src}
        />
    );
};

export const TaskList: React.FC = () => {
    const [query, setQuery] = useState("");
    const [title, setTitle] = useState("");
    const [image, setImage] = useState<File | null>(null);
    const [isImageDragActive, setIsImageDragActive] = useState(false);
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

        const attachments = image
            ? [
                  await ontology.attachments!.create(image, {
                      target: { objectType: "Task", property: "attachments" },
                  }),
              ]
            : undefined;

        withViewTransition(() => {
            setTitle("");
            setImage(null);
            createTask({ title: nextTitle, location: coords ?? undefined, attachments });
        });
    };

    const handleImageFile = (file: File | null) => {
        if (!file) {
            setImage(null);
            return;
        }
        if (!file.type.startsWith("image/")) {
            return;
        }
        setImage(file);
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
        setImage(new File([blob], "demo-attachment.png", { type: "image/png" }));
    };

    const handleDeleteTask = (taskId: string) => {
        withViewTransition(() => {
            deleteTask({ task: taskId });
        });
    };

    const handleToggleTask = (taskId: string, completedAt: unknown) => {
        withViewTransition(() => {
            if (completedAt) {
                reopenTask({ task: taskId });
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
                        <h1 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
                            Create task
                        </h1>
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
                                    disabled={!title.trim()}
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
                            {image && (
                                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                                    <span className="min-w-0 truncate">
                                        Will attach {image.name} ({formatFileSize(image.size)})
                                    </span>
                                    <button
                                        className="shrink-0 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                                        onClick={() => setImage(null)}
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
                                            <TaskAttachmentPreview attachment={task.attachments[0]} />
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
