import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 關卡吃的是建好的產物，不是你剛改的原始碼。
 *
 * ## 這是一個會製造假結果的坑
 *
 * 三十四道關卡全部從 `apps/example/dist` 起一個伺服器。改完原始碼直接跑關卡，
 * 量到的是**上一次建的東西** —— 而它會安靜地給你一個看起來很合理的答案。
 *
 * 實測踩過：破壞八面體的折疊、跑紅測、還原原始碼，然後**沒有重建**就跑了下一輪
 * 關卡。那一輪量到「後方那一點是紅色不是黃色」，我當成新發現的 bug 追了很久 ——
 * 而那其實是上一輪破壞留下來的產物。
 *
 * 一個測到舊產物的關卡比沒有關卡更糟：它給的是**有信心的錯誤答案**。
 *
 * ## 為什麼是丟例外而不是警告
 *
 * 警告會被捲過去。而這件事一旦發生，那一輪的每一個數字都是沒有意義的 ——
 * 沒有「大致還能用」這個中間狀態。
 */

const SKIP = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage']);

/** 目錄底下最新的檔案與它的 mtime。空目錄或不存在回 null。 */
export function newest(dir, skip = SKIP) {
  let best = null;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const mtimeMs = statSync(path).mtimeMs;
      if (best === null || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    }
  };
  walk(dir);
  return best;
}

/**
 * 原始碼比產物新嗎。
 *
 * @param root 專案根目錄。
 * @param sources 要看的原始碼目錄，相對於 root。
 * @param dist 產物目錄，相對於 root。
 */
export function distFreshness(
  root,
  sources = ['apps/example/src', 'packages/three/src', 'packages/format/src'],
  dist = 'apps/example/dist',
) {
  let source = null;
  for (const relative of sources) {
    const found = newest(join(root, relative));
    if (found !== null && (source === null || found.mtimeMs > source.mtimeMs)) source = found;
  }
  // `dist` 底下沒有要跳過的子目錄，但也不會有 node_modules —— 傳空集合最單純。
  const built = newest(join(root, dist), new Set());
  return {
    source,
    dist: built,
    // 產物不存在也算過期：那時候伺服器會 404，而症狀是「等 __ww 逾時」。
    stale: built === null || (source !== null && source.mtimeMs > built.mtimeMs),
  };
}

/** 產物過期就丟例外，訊息裡說清楚是哪一個檔案比較新。 */
export function assertDistFresh(root, sources, dist) {
  const state = distFreshness(root, sources, dist);
  if (!state.stale) return state;
  const which =
    state.dist === null ? '產物根本不存在' : `${state.source.path} 比 ${state.dist.path} 新`;
  throw new Error(
    `關卡吃的是建好的產物，而它是舊的（${which}）。\n` +
      '先跑 pnpm --filter @ww/example-app build 再來。\n' +
      '舊產物給的是有信心的錯誤答案 —— 那比沒有關卡更糟，所以這裡直接停。',
  );
}
