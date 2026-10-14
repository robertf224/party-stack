import { defineAppConfig } from "@party-stack/build-config";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { lazyPlugins } from "vite-plus";

// https://vite.dev/config/
export default defineAppConfig({ plugins: lazyPlugins(() => [react(), tailwindcss()]) });
