export default {
    test: {
        // Fixtures start Vite servers over one root and dependency optimizer cache.
        // Parallel servers can invalidate modules underneath another worker's RPC streams.
        fileParallelism: false,
        include: ["e2e/**/*.test.ts"],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        expect: { poll: { timeout: 5_000 } },
    },
};
