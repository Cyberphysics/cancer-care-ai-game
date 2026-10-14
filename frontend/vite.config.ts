import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 0 note: the deployed frontend is served from S3 through CloudFront and does
// not call the API yet. The `/api` proxy below exists so that local development has a
// working path to the deployed API once Phase 2 wires real calls in.
//
// Set VITE_API_PROXY_TARGET to the deployed API base URL, e.g.
//   VITE_API_PROXY_TARGET=https://abc123.execute-api.us-east-1.amazonaws.com
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    proxy: process.env.VITE_API_PROXY_TARGET
      ? {
          '/api': {
            target: process.env.VITE_API_PROXY_TARGET,
            changeOrigin: true,
          },
        }
      : undefined,
  },
});
