import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies API calls to a locally running orchestrator
// (default :8080) or to the in-cluster platform via API_PROXY_TARGET.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
      '/healthz': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
