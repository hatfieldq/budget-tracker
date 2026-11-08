/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1', // loopback only, never the LAN
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
  preview: { host: '127.0.0.1', port: 5173 },
  test: { environment: 'jsdom' },
});
