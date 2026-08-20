import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../lib/browser.mjs';
import { ROOT } from '../lib/repo-root.mjs';
import { serveDist } from '../lib/serve.mjs';

/**
 * 把每一個會發布的套件打包起來，裝進一個**乾淨的專案**，然後真的用一次。
 *
 * ## 為什麼這個檢查不能省
 *
 * 工作區裡 `exports` 直指 `src/`，所以 `pnpm test`、`pnpm typecheck`、
 * example app —— **全部都碰不到 `dist`**。打包壞掉的話，在這裡什麼徵兆
 * 都沒有，要等到有人 `npm install` 才炸。
 *
 * 這是唯一會用到「使用者那一側」解析規則的檢查：
 *
 * - `publishConfig.exports` 有沒有真的把進入點換成 `dist`
 * - `three` 是 peer，所以裝進去之後**必須**用外面那一份
 * - `@webworld/format` 是共用的格式契約，兩個套件必須解析到同一份
 * - 發布內容裡有沒有混進不該有的東西
 *
 * ## 為什麼用 pnpm 打包、用 npm 安裝
 *
 * `npm pack` **不套用 `publishConfig`**，產出的 tarball 進入點還指著
 * `src/index.ts` —— 那不是使用者會拿到的東西。pnpm 會套用。
 *
 * 安裝則刻意用 npm：它的解析最嚴格，`workspace:` 協定會直接失敗，
 * peerDependency 也不會自動補上。
 */

const work = mkdtempSync(join(tmpdir(), 'ww-verify-'));

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    // Windows 的 npm/pnpm 是 .cmd，不走 shell 找不到它。
    shell: process.platform === 'win32',
  });

/** 依相依順序打包：後面的會用到前面的 tarball。 */
const PACKAGES = ['format', 'three', 'cook'];

const CHECK = `
import { InstancedMesh, worldFor, sphericalLodErrors, load } from '@webworld/three';
import { ASSET_SCHEMA_VERSION, MESH_MAGIC } from '@webworld/format';
import { cookAll, COOKER_VERSION } from '@webworld/cook';
import { BatchedMesh, BoxGeometry, MeshBasicMaterial, Scene, SphereGeometry } from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';

const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 8, {
  autoLod: false,
});
const scene = new Scene();
scene.add(mesh);

// peer 有沒有生效：套件裡的 BatchedMesh 必須**就是**外面那一份。
if (!(mesh instanceof BatchedMesh)) {
  throw new Error('instanceof BatchedMesh 失敗 —— 裝到了第二份 three');
}
if (mesh.count !== 8) throw new Error('count 不對：' + mesh.count);
if (worldFor(scene).stats.objects !== 1) throw new Error('worldFor 沒找到物件');
if (typeof load !== 'function') throw new Error('load 沒有被匯出');
if (sphericalLodErrors([new BoxGeometry(1, 1, 1)]).length !== 1) {
  throw new Error('sphericalLodErrors 不對');
}

// 格式契約：cook 產出的東西 runtime 必須認得。
if (typeof ASSET_SCHEMA_VERSION !== 'number') throw new Error('ASSET_SCHEMA_VERSION 不見了');
if (typeof MESH_MAGIC !== 'number') throw new Error('MESH_MAGIC 不見了');
if (typeof COOKER_VERSION !== 'string') throw new Error('COOKER_VERSION 不見了');

// cooker 真的能跑一遍（內建的程序化資產，不需要外部檔案）。
const { manifest, files } = await cookAll({ builtins: true, textureSize: 64, collision: false });
const ids = Object.keys(manifest.meshes);
if (ids.length === 0) throw new Error('cookAll 沒有產出任何 mesh');
if (manifest.schemaVersion !== ASSET_SCHEMA_VERSION) {
  throw new Error(
    'cook 產出的 schema v' + manifest.schemaVersion +
      ' 與 runtime 的 v' + ASSET_SCHEMA_VERSION + ' 不符 —— 兩個套件解析到不同的 @webworld/format',
  );
}
const wwm = [...files.keys()].find((n) => n.endsWith('.wwm'));
if (wwm === undefined) throw new Error('cookAll 沒有產出 .wwm');
if (new DataView(files.get(wwm).buffer, files.get(wwm).byteOffset).getUint32(0, true) !== MESH_MAGIC) {
  throw new Error('.wwm 的 magic 不對');
}

// 自動 LOD 必須真的產生出階來。
//
// **這一段是被一個真的 bug 逼出來的**：先前的檢查用 autoLod: false，
// 於是跑到了 dist 卻剛好繞開唯一會壞的那條路 —— worker 的 URL 被建成
// 絕對路徑，在使用者的網站上 404，然後靜靜退回主執行緒。
const auto = new InstancedMesh(new SphereGeometry(1, 32, 24), new MeshBasicMaterial(), 4);
await auto.lodReady;
if (auto.levelCount <= 1) {
  throw new Error('自動 LOD 沒有產生任何階 —— dist 裡的 lod chunk 可能沒被打包進去');
}
if (auto.lodStats === null) throw new Error('lodStats 是 null，自動 LOD 沒有跑');

// 把 cook 出來的東西寫到磁碟，讓瀏覽器那一段真的用 HTTP 載一次。
// 少了這一步，「cook 產出的貼圖 runtime 載不載得進來」永遠沒被驗過 ——
// 而那正是 cook 與 runtime 之間唯一一條需要兩邊同時正確的路。
mkdirSync('cooked-assets', { recursive: true });
writeFileSync('cooked-assets/assets.manifest.json', JSON.stringify(manifest));
for (const [name, bytes] of files) writeFileSync('cooked-assets/' + name, bytes);

console.log(
  'OK: 三個套件都裝得起來、跑得動，格式版本一致（' + ids.length + ' 個 mesh）；' +
    '自動 LOD 產生 ' + auto.levelCount + ' 階',
);
`;

try {
  const tarballs = [];
  for (const name of PACKAGES) {
    console.log(`打包 @webworld/${name}…`);
    run('pnpm', ['pack', '--pack-destination', work], join(ROOT, 'packages', name));
  }
  for (const file of readdirSync(work)) {
    if (file.endsWith('.tgz')) tarballs.push(`./${file}`);
  }
  if (tarballs.length !== PACKAGES.length) {
    throw new Error(`預期 ${PACKAGES.length} 個 tarball，實際 ${tarballs.length} 個`);
  }

  console.log(`裝進乾淨專案：${work}`);
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'ww-consumer', private: true, type: 'module' }, null, 2),
  );
  run('npm', ['install', '--no-audit', '--no-fund', 'three', ...tarballs], work);

  writeFileSync(join(work, 'check.mjs'), CHECK);
  console.log(run('node', ['check.mjs'], work).trim());

  await checkInBrowser(work);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/**
 * 把套件**用打包工具打包起來、部署、在真的瀏覽器裡跑**，確認 worker 會啟動。
 *
 * ## 為什麼非得走完整條路
 *
 * worker 壞掉的樣子是**靜靜退回主執行緒**：畫面完全正常，只是開場多一次
 * 卡頓。沒有例外、沒有紅字，測試全綠。要看見它，只能真的跑起來然後問
 * 「剛才那件事在哪個執行緒做的」。
 *
 * 而且中間每一段都不能省：
 *
 * - **Node 裡跑不算**：沒有 `Worker`，一定走退路。
 * - **原生 ESM 直接讀 `node_modules` 不算**：那樣 worker 的兄弟檔案永遠
 *   找得到。真實部署裡 `node_modules` **不會上線**，只有打包產出會。
 *   這一步曾經漏掉整個 bug。
 * - **所以要打包，而且只 serve 產出目錄**。那才是使用者的網站長的樣子：
 *   打包工具沒搬過去的檔案，就是不存在。
 *
 * 用 esbuild 是刻意的 —— 它是三大打包工具裡**最不認得** `new URL(...,
 * import.meta.url)` 這種 worker 寫法的那一個。它過得了，其餘的也會過。
 */
async function checkInBrowser(dir) {
  const { build } = await import('esbuild');

  writeFileSync(
    join(dir, 'app.js'),
    `import { InstancedMesh, load, loadMaterial } from '@webworld/three';
import { SphereGeometry, MeshBasicMaterial } from 'three';

const mesh = new InstancedMesh(new SphereGeometry(1, 32, 24), new MeshBasicMaterial(), 4);

// cook → 發布 → 用 HTTP 載回來。網格與材質兩條路都走一次。
// 材質那條特別重要：它跨越 cook 與 runtime 兩個套件，而失敗的樣子是
// 「模型變成純色」—— 沒有例外，沒有紅字。
const MANIFEST = '/cooked/assets.manifest.json';
const asset = Promise.all([
  load(MANIFEST, 'mesh:rock-large'),
  loadMaterial(MANIFEST, 'mesh:rock-large'),
]);

Promise.all([mesh.lodReady, asset]).then(
  ([, [chain, material]]) => {
    const of = (t) => (t === null ? null : { format: t.format, width: t.mipmaps?.[0]?.width, mips: t.mipmaps?.length });
    window.__result = {
      levels: mesh.levelCount,
      stats: mesh.lodStats,
      cooked: {
        lods: chain.lods.length,
        map: of(material.map),
        normalMap: of(material.normalMap),
        ormShared: material.aoMap === material.roughnessMap && material.aoMap !== null,
        regeneratesMips: material.map?.generateMipmaps ?? null,
      },
    };
  },
  (e) => { window.__result = { error: String(e && e.stack ? e.stack : e) }; },
);`,
  );

  const site = join(dir, 'site');
  await build({
    entryPoints: [join(dir, 'app.js')],
    bundle: true,
    format: 'esm',
    // 動態 import 要真的變成分開的 chunk —— 那正是 LOD 那條路的形狀。
    splitting: true,
    outdir: site,
    absWorkingDir: dir,
    logLevel: 'silent',
  });

  writeFileSync(
    join(site, 'index.html'),
    '<!doctype html><meta charset="utf-8"><script type="module" src="./app.js"></script>',
  );

  // cook 出來的資產也要進產出目錄 —— 真實專案是把它們放進 public/ 的。
  cpSync(join(dir, 'cooked-assets'), join(site, 'cooked'), { recursive: true });

  // 只 serve 打包產出。`node_modules` 在這裡碰不到，就跟部署之後一樣 ——
  // 「出不了根目錄」是共用實作擋的，而那正是這一段要模擬的事。
  const served = await serveDist(site);

  // 這裡不在乎用哪一個瀏覽器 —— 要驗的是「worker 起不起得來」，不是效能。
  let browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    served.close();
    throw new Error('worker 那一段沒驗到。\n    pnpm exec playwright install chromium', {
      cause: error,
    });
  }

  try {
    const page = await browser.newPage();
    // 這裡收集的東西是**診斷的全部**。worker 出事時主執行緒收到的訊息
    // 往往只是「少了一階」，真正的原因（404、CSP 擋掉 blob:）只出現在
    // console 與失敗的請求裡。
    const problems = [];
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    page.on('requestfailed', (r) => problems.push(`載入失敗 ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
    });

    await page.goto(`${served.origin}/`);
    const result = await page
      .waitForFunction(() => window.__result, null, { timeout: 30_000 })
      .then((h) => h.jsonValue());

    const fail = (why) => {
      throw new Error(
        `${why}\n瀏覽器訊息：${problems.join('\n         ') || '（無）'}\n\n` +
          'dist 裡的 worker 若靠路徑解析，打包工具不會把那個檔案搬進使用者的\n' +
          '產出目錄，於是 404 之後靜靜退回主執行緒 —— 畫面正常，只是開場卡頓。',
      );
    };

    if (result.error !== undefined) fail(`瀏覽器裡失敗：${result.error}`);
    if (result.levels <= 1) fail('瀏覽器裡沒有產生 LOD 階。');
    if (result.stats?.offMainThread !== true) fail('worker 沒有啟動，退回了主執行緒。');

    // ── cook 出來的資產 ──
    const cooked = result.cooked ?? {};
    if (!(cooked.lods > 1)) fail(`cook 過的網格只有 ${cooked.lods} 階。`);
    // 貼圖沒接上時模型只會變成純色。Three 的常數：33776 = BC1、36285 = BC5。
    if (cooked.map === null) fail('cook 過的材質沒有 albedo 貼圖。');
    if (cooked.normalMap === null) fail('cook 過的材質沒有法線貼圖。');
    if (!(cooked.map.mips > 1)) fail(`albedo 只有 ${cooked.map.mips} 階 mip。`);
    if (cooked.regeneratesMips !== false) {
      fail('貼圖在 runtime 重算 mip —— cook 好的那幾階被丟掉了。');
    }
    if (cooked.ormShared !== true) fail('aoMap 與 roughnessMap 不是同一個實例。');
    console.log(
      `OK: 瀏覽器裡 worker 正常啟動（${result.levels} 階，` +
        `${result.stats.generationMs.toFixed(1)} ms 在 worker 裡）；` +
        `cook 過的資產 ${cooked.lods} 階，貼圖 ${cooked.map.width}² fmt${cooked.map.format}／` +
        `${cooked.map.mips} 階 mip`,
    );
  } finally {
    await browser.close();
    served.close();
  }
}
