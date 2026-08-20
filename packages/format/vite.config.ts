import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

/**
 * 發布用的 build。
 *
 * 這個套件是 `@webworld/three`（解碼）與 `@webworld/cook`（產生）之間的
 * **格式契約**：`.wwm` 的位元佈局、區塊參照，以及 `ASSET_SCHEMA_VERSION`。
 *
 * 它必須是**一個獨立發布的套件**而不是各自內聯一份 —— 兩邊各自內聯的話，
 * 版本會悄悄分岔，而症狀是「cook 完載不進去」且訊息指向錯的方向。
 * 有了共用的套件，npm 的版本解析就是那個契約的守門員。
 */
export default defineConfig({
  build: {
    target: 'esnext',
    // Source map 會發布出去。理由與量到的大小寫在
    // `packages/three/vite.config.ts` —— 三個套件同一個決定。
    sourcemap: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: 'index',
    },
  },
  plugins: [
    dts({
      // 把型別攤平成一份 `index.d.ts`。不攤平的話，發布出去的宣告檔會
      // `import '@ww/engine'` —— 一個 npm 上不存在的套件。
      tsconfigPath: fileURLToPath(new URL('tsconfig.build.json', import.meta.url)),
    }),
  ],
});
