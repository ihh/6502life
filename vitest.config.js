import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['board/test/**/*.test.js', 'engine/test/**/*.test.js'],
        testTimeout: 30000,
    },
});
