import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑不需要 GPU 的純邏輯測試。需要真實 adapter 的驗證走 `pnpm bench`。
    include: ['packages/*/src/**/*.test.ts', 'internal/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts', 'tools/lib/**/*.test.mjs'],
    environment: 'node',
  },
});
