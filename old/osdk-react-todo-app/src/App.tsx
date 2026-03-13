import {
    useAction,
    useLiveObjectSet,
    useObjects,
    isKnownActionError,
    useAggregations,
} from "@bobbyfidz/osdk-react";
import { createTask, Task } from "@gtd/sdk";
import React, { Suspense } from "react";
import TaskItem from "./TaskItem";
import FlipMove from "react-flip-move";
import { UserMenu } from "./UserMenu";
// import ChatWindow from "./ChatWindow";

function App() {
    const {
        data: tasks,
        hasNextPage,
        isFetchingNextPage,
        fetchNextPage,
    } = useObjects(Task, {
        $orderBy: { completedAt: "asc", createdAt: "desc" },
        $pageSize: 10,
    });
    useLiveObjectSet(Task);

    const { mutate: addTask, isPending } = useAction(createTask);
    const [newTaskTitle, setNewTaskTitle] = React.useState("");

    const handleAddTask = () => {
        if (!newTaskTitle.trim()) return;
        // Add the new task with the title
        addTask(
            { title: newTaskTitle },
            {
                onSuccess: () => setNewTaskTitle(""),
                onError: (error) => {
                    if (isKnownActionError(error)) {
                        console.error("Known error", error);
                    } else {
                        console.error("Unknown error", error);
                    }
                },
            }
        );
    };

    const {
        data: { $count: totalTodos },
    } = useAggregations(Task, {
        $select: {
            $count: "unordered",
        },
    });

    return (
        <div className="min-h-screen bg-gray-100">
            <div className="absolute right-4 top-4">
                <Suspense fallback={<div>Loading...</div>}>
                    <UserMenu />
                </Suspense>
            </div>
            <div className="p-8">
                <div className="mx-auto max-w-xl">
                    <h1 className="mb-6 text-center text-3xl font-bold">
                        Todos {totalTodos ? `(${totalTodos})` : ""}
                    </h1>
                    <div className="mb-6 flex">
                        <input
                            type="text"
                            value={newTaskTitle}
                            onChange={(e) => setNewTaskTitle(e.target.value)}
                            placeholder="Add a new task"
                            className="flex-grow rounded-l-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                        <button
                            onClick={handleAddTask}
                            type="button"
                            disabled={isPending}
                            className="rounded-r-lg bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
                        >
                            {isPending ? "Adding..." : "Add Task"}
                        </button>
                    </div>
                    {tasks && tasks.length > 0 ? (
                        <FlipMove className="flex flex-col gap-4">
                            {tasks.map((task) => (
                                <div key={task.id}>
                                    <TaskItem task={task} />
                                </div>
                            ))}
                        </FlipMove>
                    ) : (
                        <p className="text-center text-gray-500">No tasks yet</p>
                    )}
                    {hasNextPage && (
                        <div className="mt-4 flex items-center justify-center">
                            <button
                                onClick={() => fetchNextPage()}
                                disabled={isFetchingNextPage}
                                className="flex items-center rounded bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
                            >
                                {isFetchingNextPage && (
                                    <svg
                                        className="mr-2 inline-block h-5 w-5 animate-spin"
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
                                {isFetchingNextPage ? "Loading..." : "Load more"}
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {/* <ChatWindow
                agentRid="ri.aip-agents..agent.75e6c53f-7bc8-4e90-85cf-c7705e6d19f4"
                sessionRid="ri.aip-agents..session.dd23d3a1-c798-4031-9756-b0ec289495e3"
            /> */}
        </div>
    );
}

export default App;
