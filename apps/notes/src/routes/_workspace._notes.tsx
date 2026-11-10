import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_workspace/_notes")({ component: Outlet });
