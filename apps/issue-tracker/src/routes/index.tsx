import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const IssueTracker = lazy(() =>
    import("../app/IssueTracker").then(({ IssueTracker }) => ({ default: IssueTracker }))
);

export const Route = createFileRoute("/")({ ssr: false, component: IssueTracker });
