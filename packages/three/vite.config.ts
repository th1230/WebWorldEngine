import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

/**
 * 發布用的 build。
 *
 * ## 為什麼要有 build，而 ADR 0003 說內部套件不做 build
 *
 * 兩件事不衝突，因為它們服務的對象不同：
 *
 * - **工作區內部**：`exports` 直指 `src/index.ts`，改了就生效，沒有 build step。
 * - **npm 上**：`publishConfig` 在發布時把 `exports` 換成 `dist/`。
 *
 * `publishConfig` 是 npm 原生的機制，所以兩邊各自拿到對的東西，而且
 * **不需要在原始碼裡分岔**。
 *
 * ## 內部套件被內聯，不發布
 *
 * `@ww/core`、`@ww/engine`、`@ww/asset-format`、`@ww/assets-runtime` 都是
 * **我們的組織方式**，不是使用者該知道的東西。它們沒有列在 external 裡，
 * 所以會被打進 `dist`。
 *
 * 反過來說：把它們一起發到 npm 的話，使用者的 `node_modules` 裡會出現
 * 五個 `@ww/*`，「對外只有一個套件」在實務上就不成立了。
 *
 * ## `three` 是 peer，不是 dependency
 *
 * 這不是體積問題，是**功能會壞**：npm 若裝了第二份 three，
 * `instanceof BatchedMesh` 會失效，而且 `three.core.js` 有兩份。
 * 使用者的專案本來就有 three，我們要用的就是他那一份。
 */
export default defineConfig({
  // 產出裡的資源路徑必須是**相對**的。
  //
  // 預設的 `/` 會讓 worker 被寫成 `new URL("/assets/lod-worker-….js", …)`，
  // 那在使用者的網站上解析到**站台根目錄** —— 那裡沒有那個檔案，於是
  // 自動 LOD 靜靜地退回主執行緒。
  base: './',
  build: {
    // 每次建置都清空。上一次建置留下的 chunk 不會被任何東西引用，但
    // `files: ["dist"]` 是整個目錄，所以它們**照樣會被發布出去** ——
    // 而且看起來就像正常產物，沒有任何徵兆說它是上一版的。
    emptyOutDir: true,
    target: 'esnext',
    // ## Source map 會跟著發布出去
    //
    // 那不是省下來的東西：`@web-world-engine/three` 的 map 有 1,400 kB，比 JS 的
    // 662 kB 還大，而且內嵌完整的 TypeScript 原始碼（`sourcesContent`）。
    //
    // 留著是因為**它不進使用者的網站**：瀏覽器只有在開發者工具打開時才
    // 去抓 `.map`，一般訪客一個位元組都不會下載。付的是 npm 安裝時的磁碟，
    // 換到的是「這個套件替你做的那些複雜的事，出問題時你踩得進去看」。
    //
    // 對一個賣點就是「幫你處理底層」的套件，那個交換是划算的。
    sourcemap: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      // three 是 peer；meshoptimizer 刻意**不** external —— 它只在 worker
      // chunk 裡，內聯之後使用者不必多裝一個相依，而且沒用到自動 LOD 的
      // 專案根本不會下載那個 chunk。
      external: [/^three($|\/)/],
    },
  },
  worker: { format: 'es' },
  plugins: [
    dts({
      // 把型別攤平成一份 `index.d.ts`。不攤平的話，發布出去的宣告檔會
      // `import '@ww/engine'` —— 一個 npm 上不存在的套件。
      rollupTypes: false,
      tsconfigPath: fileURLToPath(new URL('tsconfig.build.json', import.meta.url)),
    }),
  ],
});
