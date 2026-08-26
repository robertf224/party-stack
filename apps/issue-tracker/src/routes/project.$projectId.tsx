import {
    createFileRoute,
    lazyRouteComponent,
} from "@tanstack/react-router";

const IssueTracker =
    lazyRouteComponent(
        () =>
            import(
                "../app/IssueTracker"
            ),
        "IssueTracker"
    );

export const Route = createFileRoute("/project/$projectId")({
    ssr: false,
    component: ProjectRoute,
});

function ProjectRoute() {
    const { projectId } =
        Route.useParams();
    return (
        <IssueTracker
            initialProjectId={
                projectId
            }
        />
    );
}
