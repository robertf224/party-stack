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
        "@effectionx/timebox",
        "@effectionx/websocket",
    ],
    webpack: (config) => {
        config.resolve ??= {};
        config.resolve.extensionAlias = {
            ...(config.resolve.extensionAlias ?? {}),
            ".js": [".ts", ".tsx", ".js", ".jsx"],
            ".mjs": [".mts", ".mjs"],
            ".cjs": [".cts", ".cjs"],
        };
        return config;
    },
};

export default nextConfig;
