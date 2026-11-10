import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";

export default defineEffectLibraryConfig({
    pack: {
        entry: [
            "src/**/*.{ts,tsx}",
            "!src/**/*.d.ts",
            "!src/**/*.test.{ts,tsx}",
            "!src/**/*.bench.{ts,tsx}",
            "!src/**/*.setup.{ts,tsx}",
        ],
    },
    test: {
        include: [],
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["src/**/*.test.ts"],
                    exclude: ["src/postgres.test.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "postgres",
                    include: ["src/postgres.test.ts"],
                    globalSetup: ["src/postgres.setup.ts"],
                },
            },
        ],
    },
});
