import React from "react";
import { useAction } from "@bobbyfidz/osdk-react";
import { editTask, Task } from "@gtd/sdk";
import { Osdk } from "@osdk/client";
import { Link } from "react-router";
import { UserAvatar } from "./UserAvatar";

interface TaskItemProps {
    task: Osdk<Task>;
}

function TaskItem({ task }: TaskItemProps) {
    const { mutate: updateTask, isPending: isUpdating } = useAction(editTask);

    const handleToggle = async (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        e.stopPropagation();
        updateTask({
            Task: task,
            // @ts-expect-error OSDK types don't allow explicit null yet.
            completed_at: task.completedAt ? null : new Date().toISOString(),
            title: task.title!,
        });
    };

    return (
        <Link
            to={`/task/${task.id}`}
            className="flex cursor-pointer items-center justify-between rounded-lg bg-white p-4 shadow hover:bg-gray-50"
        >
            <div className="flex w-full items-center justify-between">
                <div className="flex items-center">
                    <div onClick={(e) => e.stopPropagation()}>
                        <input
                            type="checkbox"
                            checked={!!task.completedAt}
                            onChange={handleToggle}
                            disabled={isUpdating}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600"
                        />
                    </div>
                    <span
                        className={`ml-3 text-lg ${task.completedAt ? "text-gray-500 line-through" : "text-gray-900"}`}
                    >
                        {task.title}
                    </span>
                </div>
                {task.createdBy ? <UserAvatar userId={task.createdBy} /> : null}
            </div>
            {isUpdating && (
                <svg
                    className="h-5 w-5 animate-spin text-blue-600"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                >
                    <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                    ></circle>
                    <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    ></path>
                </svg>
            )}
        </Link>
    );
}

export default TaskItem;
