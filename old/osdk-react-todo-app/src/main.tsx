import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { OsdkEnvironmentProvider } from "@bobbyfidz/osdk-react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import App from "./App";
import Login from "./Login";
import AuthCallback from "./AuthCallback";
import TaskPage from "./TaskPage";
import "./globals.css";
import { client } from "./client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

const router = createBrowserRouter(
    [
        {
            path: "/",
            element: <App />,
        },
        {
            path: "/login",
            element: <Login />,
        },
        {
            path: "/auth/callback",
            element: <AuthCallback />,
        },
        {
            path: "/task/:taskId",
            element: <TaskPage />,
        },
    ],
    { basename: import.meta.env.BASE_URL }
);

// TODO: re-add StrictMode
createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
        <OsdkEnvironmentProvider client={client}>
            <Suspense fallback="Loading...">
                <RouterProvider router={router} />
            </Suspense>
        </OsdkEnvironmentProvider>
    </QueryClientProvider>
);
