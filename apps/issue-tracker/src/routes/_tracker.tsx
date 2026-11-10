import { createFileRoute, useParams } from "@tanstack/react-router";
import { lazy } from "react";

const IssueTracker = lazy(() =>
    import("../app/IssueTracker").then(({ IssueTracker }) => ({ default: IssueTracker }))
);
export const Route = createFileRoute("/_tracker")({ ssr: false, component: TrackerLayout });
function TrackerLayout() {
    const { projectId } = useParams({ strict: false });
    return <IssueTracker initialProjectId={projectId} />;
}
