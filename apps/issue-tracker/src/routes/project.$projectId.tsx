import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const IssueTracker = lazy(() =>
    import("../app/IssueTracker").then(({ IssueTracker }) => ({ default: IssueTracker }))
);

export const Route = createFileRoute("/project/$projectId")({ ssr: false, component: ProjectRoute });

function ProjectRoute() {
    const { projectId } = Route.useParams();
    return <IssueTracker initialProjectId={projectId} />;
}
