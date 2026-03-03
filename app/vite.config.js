import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@board': path.resolve(__dirname, '../board'),
            '@engine': path.resolve(__dirname, '../engine'),
        },
    },
});
