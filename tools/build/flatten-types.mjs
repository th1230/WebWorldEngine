/**
 * 把 `tsc` 吐出來的宣告樹整理成可以發布的形狀。**三個套件共用一份。**
 *
 * ## 為什麼需要這一步
 *
 * `tsc` 的 `rootDir` 會被推導成所有輸入的共同祖先，而工作區的 `paths` 讓
 * 內部套件的原始碼也算輸入 —— 於是宣告檔散在 `dist/packages/cook/src/`、
 * `dist/internal/engine/src/`… 底下，而 `package.json` 指的是 `dist/index.d.ts`。
 *
 * 這裡把那棵子樹**整個往上搬到 `dist/`，保留目錄結構**，其餘刪掉。
 *
 * ## 為什麼不是「攤平」
 *
 * 先前每個套件各有一份 99 行的複製，做的是真的攤平：只把 src 那一層的
 * `*.d.ts` 搬上去，子目錄整棵刪掉。那在 `@web-world-engine/cook` 上造成兩個 bug，
 * 而**這個 repo 裡沒有任何東西看得見**：
 *
 * - `dist/pipeline.d.ts` 引用 `./texture/ktx2.js`，而那個目錄被刪了 ——
 *   主進入點的型別在使用者那邊解析失敗
 * - `@web-world-engine/cook/texture` 宣告的 `dist/texture.d.ts` 從來沒被產生過 ——
 *   那個子路徑完全沒有型別
 *
 * 兩個都是 `publint` 與 `@arethetypeswrong/cli` 抓出來的。攤平本身就是問題：
 * 有子目錄的套件一定會撞名（`texture/index.d.ts` 對上 `src/index.d.ts`），
 * 而「撞名就刪掉一個」不會有人發現。
 *
 * ## 這一步也是三道檢查
 *
 * 1. 對外的宣告不能引用**不會發布的東西**（`@ww/…` 內部套件、跑出 `dist`
 *    的相對路徑）。那種錯在工作區裡解析得到，要等使用者裝了才炸。
 * 2. `publishConfig.exports` 裡每一個 `types` 指的檔案**必須真的存在**。
 *    先前那兩個 bug 就是這一條擋得住的。
 * 3. 每一個 `types` 旁邊的 `default`（實際的 JS）也必須存在。
 */
import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const packageDir = process.argv[2] ?? process.cwd();
const dist = join(packageDir, 'dist');
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));

/**
 * 找出 tsc 把這個套件的原始碼放在哪一層。
 *
 * 用**主進入點**去找，不用寫死的哨兵檔名。先前三份複製各自寫死了一個
 * （`manifest.d.ts` / `instanced-mesh.d.ts` / `cli.d.ts`）—— 那個檔案改個
 * 名字，build 就會靜靜地打包出空的型別。
 */
const entry = manifest.exports?.['.'];
if (typeof entry !== 'string') {
  throw new Error(`flatten-types: ${manifest.name} 的 exports["."] 不是一個路徑`);
}
const entryDecl = entry.replace(/^\.\//, '').replace(/\.ts$/, '.d.ts');

async function everyDeclaration(dir) {
  const out = [];
  for (const one of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, one.name);
    if (one.isDirectory()) out.push(...(await everyDeclaration(full)));
    else if (one.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// ## rootDir 吃掉多少前綴是**看情況**的
//
// `@web-world-engine/format` 零相依，tsc 的 rootDir 就是它自己的 `src/`，宣告直接
// 落在 `dist/index.d.ts`。`@web-world-engine/cook` 透過 paths 拉進內部套件，共同
// 祖先變成 repo 根目錄，於是落在 `dist/packages/cook/src/index.d.ts`。
//
// 所以先找完整的相對路徑，找不到再退回只比對檔名 —— 兩種情況都涵蓋，而且
// 不必知道 rootDir 被算成什麼。
const candidates = await everyDeclaration(dist);
const suffix = sep + entryDecl.split('/').join(sep);
const base = sep + entryDecl.split('/').pop();
const exact = candidates.filter((f) => f.endsWith(suffix));
const loose = candidates.filter((f) => f.endsWith(base));
const pool = exact.length > 0 ? exact : loose;
if (pool.length === 0) {
  throw new Error(`flatten-types: 在 ${dist} 底下找不到 ${entryDecl}（也找不到同名檔）`);
}
// 最淺的那一個是主進入點；同名的深層檔案（例如 `texture/index.d.ts`）是子路徑。
const depth = (f) => f.split(sep).length;
const entryFile = pool.reduce((best, f) => (depth(f) < depth(best) ? f : best));
const srcRoot = dirname(entryFile);

const declarations = await everyDeclaration(srcRoot);
if (declarations.length === 0) {
  throw new Error(`flatten-types: ${srcRoot} 裡沒有宣告檔`);
}

// ## 對外的宣告只能引用發布出去的東西
//
// 同一個 dist 裡的兄弟檔案，或列在 dependencies / peerDependencies 裡的套件。
// 兩種違規在工作區裡都解析得到，所以只有使用者裝了之後才會炸。
const allowed = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

const leaks = [];
for (const file of declarations) {
  const source = await readFile(file, 'utf8');
  // 宣告檔裡的 `./x.ts` 在使用者的 TypeScript 下解析不到
  const rewritten = source.replace(/(from\s+['"]\.[^'"]*)\.ts(['"])/g, '$1.js$2');

  // 先把註解剝掉再掃：用法範例裡的 `import … from '@web-world-engine/three'` 不是
  // 真的匯入，掃到它會變成一個永遠為真的假警報。
  const code = rewritten.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const shown = relative(srcRoot, file).split(sep).join('/');
  for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      // 相對路徑要留在這棵樹裡。走出去的話 tarball 裡沒有那個檔案。
      const target = join(dirname(file), specifier);
      if (!target.startsWith(srcRoot + sep) && target !== srcRoot) {
        leaks.push(`${shown} → ${specifier}（跑出 dist 之外）`);
      }
      continue;
    }
    const pkg = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (!allowed.has(pkg)) leaks.push(`${shown} → ${specifier}（不在 dependencies 裡）`);
  }
  await writeFile(file, rewritten);
}

if (leaks.length > 0) {
  throw new Error(
    'flatten-types: 對外的宣告引用了使用者拿不到的東西：\n' +
      leaks.map((l) => `  ${l}`).join('\n') +
      '\n\n要嘛在這個套件裡自己定義一份，要嘛把那個套件列進 dependencies。',
  );
}

// ── 搬上來，保留結構 ──
if (srcRoot !== dist) {
  await cp(srcRoot, dist, { recursive: true });
  for (const one of await readdir(dist, { withFileTypes: true })) {
    if (!one.isDirectory()) continue;
    // srcRoot 的第一層目錄名（例如 `packages`）整棵刪掉；`assets` 是
    // vite 的產物，不能碰。
    const first = relative(dist, srcRoot).split(sep)[0];
    if (one.name === first && one.name !== 'assets') {
      await rm(join(dist, one.name), { recursive: true });
    }
  }
}

// ── publishConfig 宣告的每一個檔案都要真的在 ──
const published = manifest.publishConfig?.exports ?? {};
const missing = [];
for (const [subpath, conditions] of Object.entries(published)) {
  const paths = typeof conditions === 'string' ? { default: conditions } : conditions;
  for (const [condition, file] of Object.entries(paths)) {
    if (typeof file !== 'string') continue;
    try {
      await stat(join(packageDir, file));
    } catch {
      missing.push(`${subpath} 的 ${condition} → ${file}`);
    }
  }
}
if (missing.length > 0) {
  throw new Error(
    'flatten-types: publishConfig.exports 指的檔案不存在：\n' +
      missing.map((m) => `  ${m}`).join('\n') +
      '\n\n發布出去之後那個子路徑就是「有 JS 沒有型別」或「整個解析失敗」，' +
      '而這裡看不出來 —— 所以擋在 build。',
  );
}

const shownCount = declarations.length;
console.log(`flatten-types: ${manifest.name} ${shownCount} 個宣告檔 → dist/`);
