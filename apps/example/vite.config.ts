import { defineConfig } from 'vite';

/**
 * `/cooked/*` 直接從 benchmark app 的輸出目錄讀。
 *
 * 那是 `pnpm cook` 的輸出，不進版控。複製一份到這裡的話，兩邊遲早會不一致
 * ——而「資產是舊的」這種錯誤看起來就只是「效果沒生效」。共用同一個目錄
 * 就沒有這個問題。
 */
export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: ['..', '../..'] },
  },
  preview: { port: 4174, strictPort: true },
  publicDir: 'public',
  build: { target: 'esnext', sourcemap: true },
  esbuild: { target: 'esnext' },
  plugins: [
    {
      name: 'ww-serve-cooked',
      configureServer(server) {
        server.middlewares.use('/cooked', async (req, res, next) => {
          const { createReadStream, existsSync } = await import('node:fs');
          const { join, resolve } = await import('node:path');
          const root = resolve(import.meta.dirname, '../benchmark/public/cooked');
          const name = (req.url ?? '/').split('?')[0]!.replace(/^\//, '');
          const file = join(root, name);
          if (!file.startsWith(root) || !existsSync(file)) return next();
          res.setHeader(
            'content-type',
            file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          );
          createReadStream(file).pipe(res);
        });
      },
    },
  ],
});
