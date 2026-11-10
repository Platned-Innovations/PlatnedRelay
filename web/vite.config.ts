import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relay API for the dev proxy. Override with RELAY_API_URL=http://localhost:<port> npm run dev
const target = process.env.RELAY_API_URL || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/v1': { target, changeOrigin: false },
      '/health': { target, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          recharts: ['recharts'],
        },
      },
    },
  },
});
