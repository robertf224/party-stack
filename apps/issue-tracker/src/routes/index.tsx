import { createFileRoute } from "@tanstack/react-router";
import { TaskList } from "../app/TaskList";

export const Route = createFileRoute("/")({
    component: TaskList,
});
