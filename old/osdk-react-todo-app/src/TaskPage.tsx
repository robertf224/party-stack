import { useAction, useObject } from "@bobbyfidz/osdk-react";
import { useAttachment, useAttachmentMetadata } from "@bobbyfidz/osdk-react/attachments";
import { Task, deleteTask, editTask } from "@gtd/sdk";
import { useParams, Link, useNavigate } from "react-router";
import { useState, useRef, useEffect } from "react";
import { Suspense } from "react";
import { Attachment } from "@osdk/client";

// Full screen image preview dialog
function ImagePreviewDialog({
    isOpen,
    onClose,
    imageUrl,
    altText,
}: {
    isOpen: boolean;
    onClose: () => void;
    imageUrl: string;
    altText: string;
}) {
    const dialogRef = useRef<HTMLDivElement>(null);

    // Handle escape key
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            onClose();
        }
    };

    // Focus the dialog when it opens
    useEffect(() => {
        if (isOpen && dialogRef.current) {
            dialogRef.current.focus();
        }
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div
            ref={dialogRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onClick={onClose}
            onKeyDown={handleKeyDown}
            tabIndex={0}
        >
            <div className="relative max-h-[80vh] max-w-4xl rounded-lg bg-white p-4 shadow-2xl">
                <button
                    onClick={onClose}
                    className="absolute right-2 top-2 z-10 rounded-full bg-white bg-opacity-80 p-2 text-gray-600 shadow-sm transition-all hover:bg-opacity-100"
                >
                    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                        />
                    </svg>
                </button>
                <img
                    src={imageUrl}
                    alt={altText}
                    className="max-h-full max-w-full rounded object-contain"
                    onClick={(e) => e.stopPropagation()}
                />
            </div>
        </div>
    );
}

function ImagePreview({ attachment }: { attachment: Attachment }) {
    const { data: dataUrl } = useAttachment(attachment);
    const { data: metadata } = useAttachmentMetadata(attachment);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);

    if (!dataUrl) return null;

    return (
        <>
            <div className="mt-2">
                <img
                    src={dataUrl}
                    alt={metadata?.filename || "Attachment preview"}
                    className="h-auto max-h-48 max-w-full cursor-pointer rounded border transition-opacity hover:opacity-90"
                    onClick={() => setIsPreviewOpen(true)}
                />
            </div>
            <ImagePreviewDialog
                isOpen={isPreviewOpen}
                onClose={() => setIsPreviewOpen(false)}
                imageUrl={dataUrl}
                altText={metadata?.filename || "Attachment preview"}
            />
        </>
    );
}

function AttachmentDisplay({ attachment }: { attachment: Attachment }) {
    const { data: metadata } = useAttachmentMetadata(attachment);
    const isImage = metadata?.mediaType.includes("image/");

    return (
        <div className="mt-4 rounded-lg bg-gray-50 p-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                    <svg
                        className="h-5 w-5 text-gray-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                        />
                    </svg>
                    <span className="text-sm font-medium text-gray-700">{metadata?.filename}</span>
                </div>
            </div>
            {isImage && <ImagePreview attachment={attachment} />}
        </div>
    );
}

function TaskPage() {
    const { taskId } = useParams();
    const navigate = useNavigate();
    const { data: task } = useObject(Task, taskId!);
    const [isEditMode, setIsEditMode] = useState(false);
    const [editedTitle, setEditedTitle] = useState("");
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { mutate: applyDeleteTask, isPending: isDeleting } = useAction(deleteTask);
    const { mutate: applyEditTask, isPending: isEditing } = useAction(editTask);

    const handleDelete = () => {
        if (window.confirm("Are you sure you want to delete this task?")) {
            applyDeleteTask({ Task: task! }, { onSuccess: () => navigate("/") });
        }
    };

    const handleEdit = () => {
        if (!editedTitle.trim() || !task) return;

        const editParams = {
            Task: task,
            title: editedTitle,
            ...(selectedFile && { attachment: selectedFile }),
        };

        applyEditTask(editParams, {
            onSuccess: () => {
                setIsEditMode(false);
                setEditedTitle("");
                setSelectedFile(null);
                if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                }
            },
        });
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null;
        setSelectedFile(file);
    };

    const removeAttachment = () => {
        if (!task) return;

        if (window.confirm("Are you sure you want to remove the attachment?")) {
            applyEditTask(
                {
                    Task: task,
                    title: task.title!,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    attachment: null as any,
                },
                {
                    onSuccess: () => {
                        // Success handled by the query update
                    },
                }
            );
        }
    };

    if (!task) {
        return <div className="flex h-screen items-center justify-center">Task not found</div>;
    }

    return (
        <div className="min-h-screen bg-gray-100 p-8">
            <div className="mx-auto max-w-xl">
                <div className="mb-6 flex items-center justify-between">
                    <Link to="/" className="text-blue-500 hover:text-blue-600">
                        ← Back to Home
                    </Link>
                    <h1 className="text-2xl font-bold">Task Details</h1>
                </div>
                <div className="rounded-lg bg-white p-6 shadow">
                    <div className="mb-4 flex items-center justify-between">
                        {isEditMode ? (
                            <div className="flex flex-1 items-center gap-2">
                                <input
                                    type="text"
                                    value={editedTitle}
                                    onChange={(e) => setEditedTitle(e.target.value)}
                                    className="flex-1 rounded border border-gray-300 px-3 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400"
                                    placeholder="Enter new title"
                                />
                                <button
                                    onClick={handleEdit}
                                    disabled={isEditing}
                                    className="rounded bg-blue-500 px-3 py-1 text-white hover:bg-blue-600 disabled:opacity-50"
                                >
                                    {isEditing ? "Saving..." : "Save"}
                                </button>
                                <button
                                    onClick={() => {
                                        setIsEditMode(false);
                                        setEditedTitle("");
                                        setSelectedFile(null);
                                        if (fileInputRef.current) {
                                            fileInputRef.current.value = "";
                                        }
                                    }}
                                    className="rounded bg-gray-500 px-3 py-1 text-white hover:bg-gray-600"
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <>
                                <h2 className="text-xl font-semibold">{task.title}</h2>
                                <button
                                    onClick={() => {
                                        setIsEditMode(true);
                                        setEditedTitle(task.title!);
                                    }}
                                    className="ml-2 rounded bg-gray-100 px-3 py-1 text-gray-600 hover:bg-gray-200"
                                >
                                    Edit
                                </button>
                            </>
                        )}
                    </div>

                    {/* File upload section in edit mode */}
                    {isEditMode && (
                        <div className="mb-4">
                            <label className="mb-2 block text-sm font-medium text-gray-700">Attachment</label>
                            <input
                                ref={fileInputRef}
                                type="file"
                                onChange={handleFileChange}
                                className="block w-full text-sm text-gray-500 file:mr-4 file:rounded-full file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
                            />
                            {selectedFile && (
                                <p className="mt-1 text-sm text-gray-600">
                                    Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                                </p>
                            )}
                        </div>
                    )}

                    {/* Display existing attachment */}
                    {task.attachment && !isEditMode && (
                        <div className="mb-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-medium text-gray-700">Attachment</h3>
                                <button
                                    onClick={removeAttachment}
                                    className="text-sm text-red-600 hover:text-red-800"
                                >
                                    Remove
                                </button>
                            </div>
                            <Suspense
                                fallback={
                                    <div className="mt-4 rounded-lg bg-gray-50 p-3">
                                        <div className="h-32 w-full animate-pulse rounded bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200"></div>
                                    </div>
                                }
                            >
                                <AttachmentDisplay attachment={task.attachment} />
                            </Suspense>
                        </div>
                    )}

                    <div className="mb-4">
                        <p className="text-gray-600">
                            Status: {task.completedAt ? "Completed" : "In Progress"}
                        </p>
                    </div>
                    <div className="mb-4">
                        <p className="text-gray-600">Created: {new Date(task.createdAt!).toLocaleString()}</p>
                    </div>
                    {task.completedAt && (
                        <div className="mb-4">
                            <p className="text-gray-600">
                                Completed: {new Date(task.completedAt).toLocaleString()}
                            </p>
                        </div>
                    )}
                    <div className="mt-6">
                        <button
                            onClick={handleDelete}
                            disabled={isDeleting}
                            className="rounded bg-red-500 px-4 py-2 text-white hover:bg-red-600"
                        >
                            {isDeleting ? "Deleting..." : "Delete Task"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default TaskPage;
