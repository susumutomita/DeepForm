import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/i/': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/c/': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../public_dist',
    emptyOutDir: true,
  },
});
