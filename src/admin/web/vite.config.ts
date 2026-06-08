import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = import.meta.dirname;

// Dev proxies the admin API to the Fastify listener (ADR-0008 §3.6);
// prod builds into the repo's dist/admin-public, served by @fastify/static.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      '@shared': resolve(here, '../shared'),
    },
  },
  build: {
    outDir: resolve(here, '../../../dist/admin-public'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8081', changeOrigin: true },
    },
  },
});
