import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    server: {
        port: 3001,
    },
    plugins: [
        devtools(),
        tanstackStart(),
        react(),
        tailwindcss(),
    ],
});
