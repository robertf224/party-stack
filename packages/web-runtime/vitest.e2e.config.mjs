export default {
    test: {
        include: ["e2e/**/*.test.ts"],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        expect: { poll: { timeout: 5_000 } },
    },
};
