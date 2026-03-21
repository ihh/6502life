import { defineConfig } from 'vite';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: path.resolve(__dirname),
  base: '/coin/',
  resolve: {
    alias: {
      '@board': path.resolve(projectRoot, 'board'),
      '@engine': path.resolve(projectRoot, 'engine'),
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: [projectRoot],
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
