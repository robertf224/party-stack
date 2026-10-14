import { defineConfig } from "vite-plus";

const taskCache = {
    input: [
        { auto: true },
        "pnpm-lock.yaml",
        // pnpm rewrites installation metadata on fresh runners.
        "!node_modules/.modules.yaml",
    ],
};

export default defineConfig({
    run: {
        tasks: {
            test: { command: "vp run -r test" },
            "check-versions": {
                command: "syncpack lint",
                // Only manifests and Syncpack configuration affect version consistency.
                cache: {
                    input: [
                        ".syncpackrc.json",
                        "package.json",
                        "pnpm-workspace.yaml",
                        "pnpm-lock.yaml",
                        "{packages,apps,old}/*/package.json",
                    ],
                },
            },
            // Package check tasks already run formatting through vp check.
            "check-format": { command: "vp fmt --check . '!{packages,apps,old}/**'", cache: taskCache },
            ci: { command: [], dependsOn: ["test", "check-versions", "check-format"] },
        },
    },
    lint: {
        plugins: ["typescript", "react", "unicorn", "oxc", "vitest", "jsx-a11y"],
        options: { typeAware: true, typeCheck: true },
        rules: {
            "vitest/require-mock-type-parameters": "off",
            "vitest/expect-expect": "off",
            "vitest/valid-expect": ["warn", { maxArgs: 2 }],
        },
        ignorePatterns: [
            // TanStack owns this generated output.
            // https://tanstack.com/router/latest/docs/installation/with-vite#ignoring-the-generated-route-tree-file
            "**/routeTree.gen.ts",
        ],
    },
    fmt: {
        printWidth: 110,
        trailingComma: "es5",
        tabWidth: 4,
        sortTailwindcss: {},
        ignorePatterns: [
            // TanStack owns this generated output; regeneration would undo our formatting.
            // https://tanstack.com/router/latest/docs/installation/with-vite#ignoring-the-generated-route-tree-file
            "**/routeTree.gen.ts",
        ],
        sortImports: {
            groups: [
                "value-builtin",
                "value-external",
                "value-internal",
                "value-parent",
                "value-sibling",
                "value-index",
                "type-import",
                "unknown",
            ],
            newlinesBetween: false,
        },
    },
    staged: {
        "*": "vp check --fix",
    },
});
