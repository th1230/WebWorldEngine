import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * 這個檔案是本專案最重要的架構防線。
 *
 * 規格的核心決策是：「Three.js 只能位於 renderer adapter 層，不能成為整套世界資料與
 * 遊戲邏輯的中心。」一句寫在文件裡的話會被違反；一條 CI 會擋的規則不會。
 *
 * 依賴方向：
 *   apps/*  →  render-three  →  render-core  →  core
 *                 ↑             ↑   ↑
 *              engine  →────────┘   │
 *                 ↓                 │
 *                ecs  →─────────────┘
 *                              diagnostics   ↗
 *                              platform-web  ↗
 *
 * 見 specs/adr/0001-three-as-adapter.md。
 */

const THREE_BAN = {
  group: ['three', 'three/*'],
  message:
    'Three.js 只能出現在 packages/render-three 與 apps/*。' +
    '引擎核心必須與 renderer backend 解耦，見 specs/adr/0001-three-as-adapter.md。',
};

const UPWARD = (from, allowed) =>
  `${from} 不可反向依賴。允許的依賴：${allowed}。見 specs/adr/0001-three-as-adapter.md。`;

/**
 * no-restricted-imports 的設定是「取代」而非「合併」，
 * 所以每一層都必須列出自己完整的 pattern 清單（含 THREE_BAN）。
 */
function layerAt(dir, patterns) {
  return {
    files: [`${dir}/**/*.ts`],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [THREE_BAN, ...patterns] }],
    },
  };
}

const layer = (dir, patterns) => layerAt(`internal/${dir}`, patterns);

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      'benchmarks/results/**',
      'playwright-report/**',
      'test-results/**',
      // 真實美術資產與上游測試資產庫。裡面有第三方的 JS（Khronos 自己的
      // 產生腳本），那不是我們的程式碼 —— 檢查它只會產生一堆改不了的錯誤，
      // 然後訓練人忽略 lint 的輸出。
      'assets/source/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Profiler 的熱路徑刻意用 non-null assertion 換取零配置；改用 ! 而非 ?? 以免多一次分支
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ── 出貨的套件裡不可以有 console.log ─────────────────────────────────
  //
  // `warn` / `error` / `info` 是刻意的：那些是要講給使用者聽的話（缺前置、
  // 接不上、只有一階幾何）。`log` 與 `debug` 只會是**查問題時留下的**。
  //
  // 這條規則不是潔癖：實測有一行 `console.log('WWDEBUG …')` 一路留到
  // `packages/three/dist` 裡 —— 那會噴進每一個使用者的主控台，而 typecheck、
  // 測試、二十道關卡沒有一個看得到它。
  //
  // cook 是 CLI，那裡的 `console.log` 就是它的輸出，所以不包含在內。
  {
    files: ['packages/three/src/**/*.ts', 'packages/format/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    },
  },

  // ── 依賴方向 ────────────────────────────────────────────────────────────
  // core：零依賴。不可依賴任何其他 workspace package。
  layer('core', [
    { group: ['@ww/*'], message: UPWARD('@ww/core', '無（core 必須零 workspace 依賴）') },
  ]),

  // asset-format：cooker 與 runtime 之間唯一的共同語言。
  // 只放型別與常數，因此除了 core 不可依賴任何東西 —— 它若依賴了別人，
  // 那個依賴就會同時被 Node 端與瀏覽器端拖進來。
  // 明確列出禁止項而非用 '@ww/*' 萬用字元：後者會連允許的 @ww/core 一起擋掉，
  // 而依賴 pattern 的否定語意（'!@ww/core'）不如白紙黑字清楚。
  layerAt('packages/format', [
    {
      group: [
        '@webworld/cook',
        '@ww/assets-runtime',
        '@ww/ecs',
        '@ww/engine',
        '@ww/diagnostics',
        '@ww/platform-web',
        '@ww/render-core',
        '@ww/render-three',
      ],
      message: UPWARD('@webworld/format', '@ww/core'),
    },
  ]),

  // asset-cooker：離線工具，跑在 Node。可以用 three 以外的任何東西處理幾何，
  // 但不該認識 renderer 或引擎執行期。
  layerAt('packages/cook', [
    {
      group: ['@ww/render-core', '@ww/render-three', '@ww/engine', '@ww/ecs', '@ww/platform-web'],
      message: UPWARD('@webworld/cook', '@ww/core、@webworld/format'),
    },
  ]),

  // assets-runtime：瀏覽器端的載入與快取。不可依賴 cooker（那是離線工具，
  // 把它打包進 runtime 會多出好幾 MB 的相依）。
  layer('assets-runtime', [
    {
      group: ['@webworld/cook', '@ww/render-three', '@ww/engine'],
      message: UPWARD('@ww/assets-runtime', '@ww/core、@webworld/format'),
    },
  ]),

  // ecs：純粹的 ECS 機制，不含任何領域知識，只可依賴 core。
  layer('ecs', [
    {
      group: ['@ww/engine', '@ww/render-core', '@ww/render-three', '@ww/platform-web', '@ww/diagnostics'],
      message: UPWARD('@ww/ecs', '@ww/core'),
    },
  ]),

  // engine：Engine Kernel。可用 ecs 與 render-core（產出 RenderFrame），
  // 但**不可**認識任何具體 renderer。
  layer('engine', [
    {
      group: ['@ww/render-three'],
      message: UPWARD('@ww/engine', '@ww/core、@ww/ecs、@ww/render-core、@ww/diagnostics'),
    },
  ]),

  // platform-web：只可依賴 core。瀏覽器/WebGPU 探測層。
  layer('platform-web', [
    {
      group: ['@ww/render-core', '@ww/render-three', '@ww/diagnostics', '@ww/ecs', '@ww/engine'],
      message: UPWARD('@ww/platform-web', '@ww/core'),
    },
  ]),

  // diagnostics：只可依賴 core。透過介面取得 renderer 統計，不認識 three。
  layer('diagnostics', [
    {
      group: ['@ww/render-core', '@ww/render-three', '@ww/platform-web', '@ww/ecs', '@ww/engine'],
      message: UPWARD('@ww/diagnostics', '@ww/core'),
    },
  ]),

  // render-core：backend-agnostic 介面層。
  // render-core 是介面層，位於 engine 之下：它定義 RenderFrame 的形狀，
  // 但不該知道 RenderFrame 是怎麼從 ECS 抽取出來的。
  layer('render-core', [
    {
      group: ['@ww/render-three', '@ww/engine', '@ww/ecs'],
      message: UPWARD('@ww/render-core', '@ww/core、@ww/diagnostics'),
    },
  ]),

  // render-three：唯一允許 import three 的**內部** package，沒有 THREE_BAN。
  {
    files: ['internal/render-three/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-restricted-imports': 'off' },
  },

  // three：**對外的那一層**，它的工作就是講 Three.js 的話 —— 使用者給
  // BufferGeometry 與 Material，我們回傳 Object3D 的子類。所以沒有 THREE_BAN。
  //
  // ADR 0001 的「Three.js 只能位於 adapter 層」是**內部**規則：引擎核心要
  // 與 renderer 無關，資料才排得成 SoA。把它套到對外介面上等於要求使用者
  // 先把世界翻譯成我們的語言，而那正是這個專案要替他省掉的事。
  // 見 specs/api.md 第二節。
  //
  // 但它**不可反向依賴 render-three / render-core**：那是 benchmark 的路徑，
  // 兩套實作的合併判準見 audit.md。也不可依賴 asset-cooker —— 那是離線
  // 工具，打包進 runtime 會多出好幾 MB。
  {
    files: ['packages/three/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ww/render-three', '@ww/render-core', '@webworld/cook'],
              message: UPWARD(
                '@webworld/three',
                '@ww/core、@ww/engine、@ww/assets-runtime、@webworld/format、three',
              ),
            },
          ],
        },
      ],
    },
  },

  // apps / tools：可自由組合。
  {
    files: ['apps/**/*.ts', 'tools/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-restricted-imports': 'off' },
  },
);
