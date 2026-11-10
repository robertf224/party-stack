import { createRouter } from "@tanstack/react-router";
import { isNotePath } from "./notes/navigation";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
    const router = createRouter({
        defaultPreload: false,
        defaultPendingMinMs: 0,
        routeTree,
        scrollRestoration: true,
        defaultViewTransition: {
            types: ({ fromLocation, toLocation }) => {
                if (
                    typeof document === "undefined" ||
                    document.visibilityState !== "visible" ||
                    !matchMedia("(max-width: 700px)").matches ||
                    matchMedia("(prefers-reduced-motion: reduce)").matches
                )
                    return false;
                const fromNote = fromLocation ? isNotePath(fromLocation.pathname) : false;
                const toNote = isNotePath(toLocation.pathname);
                return fromNote === toNote ? false : [toNote ? "notes-forward" : "notes-back"];
            },
        },
    });
    return router;
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
