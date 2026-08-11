import { createFileRoute } from "@tanstack/react-router";
import { IssueTracker } from "../app/IssueTracker";

export const Route = createFileRoute("/project/$projectId")({
    component: ProjectRoute,
});

function ProjectRoute() {
    const { projectId } = Route.useParams();
    return <IssueTracker initialProjectId={projectId} />;
}
