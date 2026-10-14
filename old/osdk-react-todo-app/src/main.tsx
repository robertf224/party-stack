import { OsdkEnvironmentProvider } from "@bobbyfidz/osdk-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import App from "./App";
import AuthCallback from "./AuthCallback";
import { client } from "./client";
import "./globals.css";
import Login from "./Login";
import TaskPage from "./TaskPage";

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
