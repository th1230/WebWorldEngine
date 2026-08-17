import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 把 tsc 吐出來的宣告樹整理成可以發布的形狀。
 *
 * ## 為什麼需要這一步
 *
 * `tsc` 的 `rootDir` 會被推導成所有輸入的共同祖先，而工作區的 `paths` 讓
 * 內部套件的原始碼也算輸入 —— 於是宣告檔散在 `dist/three/src/`、
 * `dist/engine/src/`、`dist/core/src/`… 底下。
 *
 * 這裡做兩件事：
 *
 * 1. 把 `dist/three/src/*.d.ts` 攤平到 `dist/`，其餘整棵刪掉
 * 2. 把相對匯入的 `.ts` 換成 `.js` —— 宣告檔裡的 `./x.ts` 在使用者的
 *    TypeScript 下解析不到
 *
 * ## 這一步也是一道檢查
 *
 * 攤平之後若還有任何 `@ww/` 的**真實匯入**，代表對外型別引用了不會發布
 * 的內部套件。那種錯誤在我們這裡完全看不出來（工作區裡它解析得到），
 * 要等使用者裝了才炸 —— 所以在這裡直接讓 build 失敗。
 */

const dist = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// tsc 的 rootDir 是所有輸入的共同祖先，而那會隨目錄結構改變（把內部套件
// 搬到 internal/ 之後就從 dist/three/src 變成 dist/packages/format/src）。
// 所以用找的，不要寫死路徑 —— 寫死的話搬一次目錄就靜靜地打包出空的型別。
async function findSrcDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.name === 'manifest.d.ts')) return dir;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSrcDir(join(dir, entry.name));
    if (found !== null) return found;
  }
  return null;
}

const from = await findSrcDir(dist);
if (from === null) throw new Error('flatten-types: 找不到宣告檔的來源目錄');

const names = (await readdir(from)).filter((n) => n.endsWith('.d.ts'));
if (names.length === 0) throw new Error(`flatten-types: ${from} 裡沒有宣告檔`);

/**
 * 對外的宣告只能引用**發布出去的東西**：同一個 `dist` 裡的兄弟檔案，
 * 或是列在 `dependencies` / `peerDependencies` 裡的套件。
 *
 * 兩種違規在工作區裡都解析得到，所以只有使用者裝了之後才會炸：
 *
 * - `@ww/…` —— 內部套件，npm 上不存在
 * - `../../…` —— 相對路徑跑出 `dist` 之外，tarball 裡沒有那個檔案
 */
const manifest = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8'));
const allowed = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

const leaks = [];
for (const name of names) {
  const source = await readFile(join(from, name), 'utf8');
  const rewritten = source.replace(/(from\s+['"]\.[^'"]*)\.ts(['"])/g, '$1.js$2');

  // 先把註解剝掉再掃：用法範例裡的 `import … from '@webworld/three'` 不是
  // 真的匯入，掃到它會變成一個永遠為真的假警報。
  const code = rewritten.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      // `./x.js` 可以，`../…` 一定跑出 dist 之外
      if (specifier.startsWith('../')) leaks.push(`${name} → ${specifier}（跑出 dist 之外）`);
      continue;
    }
    const pkg = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (!allowed.has(pkg)) leaks.push(`${name} → ${specifier}（不在 dependencies 裡）`);
  }
  await writeFile(join(dist, name), rewritten);
}

if (leaks.length > 0) {
  throw new Error(
    'flatten-types: 對外的宣告引用了使用者拿不到的東西：\n' +
      leaks.map((l) => `  ${l}`).join('\n') +
      '\n\n要嘛在這個套件裡自己定義一份，要嘛把那個套件列進 dependencies。',
  );
}

for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== 'assets') {
    await rm(join(dist, entry.name), { recursive: true });
  }
}


console.log(`flatten-types: ${names.length} 個宣告檔 → dist/`);
