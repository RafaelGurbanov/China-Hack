import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The frontend is a separate Vite app. In development it proxies /api to the
// Express server; in production Express serves the built files from dist/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: false } },
  },
  build: { outDir: 'dist' },
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.js'] },
});
