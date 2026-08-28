import {
    createFileRoute,
    lazyRouteComponent,
} from "@tanstack/react-router";

export const Route = createFileRoute("/")({
    ssr: false,
    component: lazyRouteComponent(
        () =>
            import(
                "../app/IssueTracker"
            ),
        "IssueTracker"
    ),
});
