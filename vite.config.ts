import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf-8')) as {
  version?: string;
};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || '1.0.0'),
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist/client',
  },
  server: {
    host: true,
    port: 5173,
    watch: {
      ignored: ['**/bin/**', '**/storage/**', '**/data/**', '**/release/**', '**/dist/**', '**/go2rtc.yaml'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
      '/go2rtc': {
        target: 'http://127.0.0.1:1984',
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/go2rtc/, ''),
      },
    },
  },
});
