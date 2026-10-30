import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";

export default defineEffectLibraryConfig({
    run: {
        tasks: {
            test: { cache: { env: ["PARTY_STACK_TEST_POSTGRES_URL"] } },
        },
    },
});
