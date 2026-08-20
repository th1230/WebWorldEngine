import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

/**
 * 發布用的 build。
 *
 * ## 什麼被內聯、什麼保持外部
 *
 * | | |
 * | --- | --- |
 * | `@ww/*` | **內聯** —— 內部套件不發布，型別也不能引用它們 |
 * | `sharp`、`@gltf-transform/*`、`mikktspace`、`meshoptimizer`、`ktx-parse` | **外部** |
 *
 * 那幾個是真正的 runtime 相依：`sharp` 有平台專屬的原生 binary，
 * 打包進來只會壞掉；其餘幾個是大型 WASM，內聯會讓套件肥好幾倍而且
 * 使用者沒辦法自己升級。
 *
 * ## 為什麼與 `@web-world-engine/three` 分成兩個套件
 *
 * 這一整套相依**絕不能出現在瀏覽器的 bundle 裡**。同一個套件同時提供
 * runtime 與 cook，打包工具就得靠 tree-shaking 保證那件事 —— 而那是
 * 一個「壞掉時完全沒有徵兆」的保證。分成兩個套件就沒有這個問題。
 */
export default defineConfig({
  build: {
    target: 'node22',
    ssr: true,
    // Source map 會發布出去。理由與量到的大小寫在
    // `packages/three/vite.config.ts` —— 三個套件同一個決定。
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL('src/index.ts', import.meta.url)),
        texture: fileURLToPath(new URL('src/texture/index.ts', import.meta.url)),
        cli: fileURLToPath(new URL('src/cli.ts', import.meta.url)),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        /^node:/,
        /^sharp$/,
        /^@gltf-transform\//,
        /^mikktspace$/,
        /^meshoptimizer/,
        /^ktx-parse$/,
        /^draco3d/,
      ],
      output: { entryFileNames: '[name].js' },
    },
  },
  plugins: [
    dts({
      tsconfigPath: fileURLToPath(new URL('tsconfig.build.json', import.meta.url)),
    }),
  ],
});
