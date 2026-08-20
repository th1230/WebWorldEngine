/**
 * 把三個發布套件推到同一個版本。
 *
 * ## 為什麼是齊步走，不是各自獨立
 *
 * `@web-world-engine/format` 是 `three` 與 `cook` 之間的格式契約，而契約裡最重要的
 * 東西不是型別，是**意思**（見 `packages/format/README.md` 裡「誤差」那一段）。
 * 兩邊解析到不同版本的 format，型別全部符合，只是意思不一樣 —— 症狀是
 * 「cook 過的資產比 runtime 產生的糊」，沒有任何錯誤訊息。
 *
 * 所以三個一起發、版本永遠相同，`metadata.mjs` 那道關卡也在守這件事。
 * 那代表有時候會發一個「什麼都沒改」的版本 —— 那個代價是刻意付的。
 *
 * ## 用法
 *
 * ```bash
 * node tools/release/version.mjs 0.2.0
 * ```
 *
 * 它只改 `package.json`。改完之後：寫 CHANGELOG、commit、開 PR 合併回 `main`。
 * 發布本身由 `.github/workflows/release.yml` 在**合併到 `main`** 時做，
 * 這裡不碰 npm。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/repo-root.mjs';

const PACKAGES = ['format', 'three', 'cook'];

const next = process.argv[2];
if (next === undefined) {
  console.error('用法：node tools/release/version.mjs <版本>，例如 0.2.0');
  process.exit(1);
}
// npm 的版本規則比看起來嚴 —— 這裡擋掉最常見的三種手誤：前面加 v、
// 少一段、多一段。發到 npm 上才發現的話，那個版本號永遠拿不回來。
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`版本格式不對：${next}（要 x.y.z，或 x.y.z-beta.1，不要加 v）`);
  process.exit(1);
}

for (const name of PACKAGES) {
  const path = join(ROOT, 'packages', name, 'package.json');
  const text = readFileSync(path, 'utf8');
  const manifest = JSON.parse(text);
  const before = manifest.version;
  manifest.version = next;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`@web-world-engine/${name}  ${before} → ${next}`);
}

console.log('');
console.log('接下來（在 develop 上）：');
console.log('  1. 寫 CHANGELOG.md（這一版改了什麼、有沒有破壞性變更）');
console.log(`  2. git commit -am "release: v${next}"`);
console.log('  3. 開 PR 合併回 main');
console.log('');
console.log('合併之後 release workflow 會跑完整驗證、發布，再補上 v' + next + ' 這個 tag。');
console.log('版本沒動的合併不會發第二次 —— 它會先問 registry。');
