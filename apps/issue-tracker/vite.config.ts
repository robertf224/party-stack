import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    ssr: {
        external: ["better-sqlite3"],
    },
    server: {
        port: 3000,
    },
    plugins: [
        devtools(),
        tanstackStart(),
        react(),
        tailwindcss(),
    ],
});
