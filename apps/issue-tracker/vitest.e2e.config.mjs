export default {
    test: {
        include: ["e2e/**/*.test.ts"],
        testTimeout: 60_000,
        hookTimeout: 30_000,
        expect: { poll: { timeout: 15_000 } },
    },
};
