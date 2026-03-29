import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['board/test/**/*.test.js', 'engine/test/**/*.test.js', 'cli/test/**/*.test.js', 'coin/test/**/*.test.js', 'compiler/test/**/*.test.js', 'webgpu/test/**/*.test.{js,mjs}'],
        testTimeout: 30000,
    },
});
