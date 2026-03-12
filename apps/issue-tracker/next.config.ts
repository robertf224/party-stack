import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "export",
    typescript: {
        ignoreBuildErrors: true,
    },
    // Effection packages ship .ts entry points; Next must transpile them.
    transpilePackages: [
        "effection",
        "@effectionx/signals",
        "@effectionx/stream-helpers",
        "@effectionx/websocket",
    ],
};

export default nextConfig;
