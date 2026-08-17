import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    // WebGPU / TSL 需要現代語法；benchmark app 不需要支援舊瀏覽器
    target: 'esnext',
    sourcemap: true,
  },
  esbuild: {
    target: 'esnext',
  },
});
