import { defineLibraryConfig } from "@party-stack/build-config";

export default defineLibraryConfig({
    run: {
        tasks: {
            dev: {
                command: "tsx watch src/index.ts",
                dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
                cache: false,
            },
        },
    },
});
