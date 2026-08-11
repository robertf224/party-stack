import { createFileRoute } from "@tanstack/react-router";
import { IssueTracker } from "../app/IssueTracker";

export const Route = createFileRoute("/")({
    component: IssueTracker,
});
