import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/*.test.ts"],
        hookTimeout: 10 * 60 * 1000,
        testTimeout: 10 * 60 * 1000,
    },
});
