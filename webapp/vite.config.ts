import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Мини-приложение раздаётся сервером под /app/, API — на том же origin (/api).
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
});
