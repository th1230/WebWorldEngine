/**
 * 發布出去的那一頁長什麼樣子。
 *
 * ## 為什麼這也要一道關卡
 *
 * `package.json` 上的 `description`、`repository`、`keywords`、`license`
 * 決定的是 npm 頁面與搜尋結果 —— 也就是**一個人決定要不要裝它的那三十秒**。
 * 少了 `repository`，npm 頁面上沒有原始碼連結；少了 `keywords`，搜尋找不到。
 *
 * 而這些欄位壞掉**在這個 repo 裡沒有任何徵兆**：typecheck 過、測試過、
 * package-check 也過（它驗的是解析與執行，不是描述）。要等到發布之後，
 * 從 npmjs.com 上看才發現。那正是這個專案最怕的形狀。
 *
 * ## 判準
 *
 * 只擋「少了會有可見後果」的東西，不擋風格：
 *
 * | 欄位 | 少了會怎樣 |
 * | --- | --- |
 * | `description` | npm 搜尋結果那一行是空的 |
 * | `license` / `author` | 頁面上沒有授權與作者 |
 * | `repository` / `bugs` / `homepage` | 沒有原始碼、回報與說明的連結 |
 * | `keywords` | 搜尋找不到 |
 * | `files` | 把整個工作目錄發出去（含 node_modules 之外的雜物） |
 * | `type: module` | 使用者的打包器把 ESM 當成 CJS |
 * | `sideEffects` | tree-shaking 不敢拿掉任何東西 |
 * | `engines` | 在太舊的 Node 上裝得起來、跑不動 |
 * | `publishConfig.exports` | **進入點還指著 `src/`** —— 使用者拿到 .ts |
 * | `README.md` 在 `files` 裡 | npm 頁面整片空白 |
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/repo-root.mjs';
import { startReport } from '../lib/report.mjs';

const PACKAGES = ['format', 'three', 'cook'];

/** 每一個都是「少了會有可見後果」，不是風格偏好。 */
const REQUIRED = [
  'name',
  'version',
  'description',
  'license',
  'author',
  'repository',
  'homepage',
  'bugs',
  'keywords',
  'type',
  'exports',
  'files',
  'sideEffects',
  'engines',
  'publishConfig',
];

const { check, finish } = startReport('發布出去的那一頁：npm 上看得到的欄位');

for (const name of PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
  const missing = REQUIRED.filter((key) => manifest[key] === undefined);
  check(
    missing.length === 0,
    `@web-world-engine/${name} 的必要欄位 —— 少了 ${missing.join('、') || '沒有'}`,
  );

  // `type: module` 講的是「這個套件是 ESM」。寫錯的話使用者的打包器會
  // 用 CJS 的規則讀它，而錯誤訊息完全指不到這裡。
  check(manifest.type === 'module', `@web-world-engine/${name} 是 ESM —— type = ${manifest.type}`);

  // 進入點必須換成 dist。這條是整份檢查裡最重要的一條：工作區裡 exports
  // 直指 src，所以沒有 publishConfig 的話**使用者會拿到 .ts 原始碼**。
  const published = manifest.publishConfig?.exports?.['.'];
  const entry = typeof published === 'string' ? published : published?.default;
  check(
    typeof entry === 'string' && entry.startsWith('./dist/'),
    `@web-world-engine/${name} 發布的進入點在 dist —— ${entry ?? '（沒有）'}`,
  );
  const types = typeof published === 'object' ? published?.types : undefined;
  check(
    typeof types === 'string' && types.endsWith('.d.ts'),
    `@web-world-engine/${name} 有型別宣告 —— ${types ?? '（沒有）'}`,
  );

  // README 不在 files 裡的話，npm 頁面是空白的。
  const files = manifest.files ?? [];
  check(files.includes('README.md'), `@web-world-engine/${name} 的 README 會被發布`);
  check(files.includes('LICENSE'), `@web-world-engine/${name} 的 LICENSE 會被發布`);

  // 版本要一致 —— 三個套件是一起發的，格式契約對不上就會出現
  // 「runtime 認不得 cook 的產出」，而那是執行期才炸的。
  check(
    manifest.version ===
      JSON.parse(readFileSync(join(ROOT, 'packages/three/package.json'), 'utf8')).version,
    `@web-world-engine/${name} 與 three 同版本 —— ${manifest.version}`,
  );
}

// three 的 peer 必須存在而且有上界。
//
// 上界買到的**不是**「結構改了會報錯」—— `assertBatchedMeshInternals` 已經
// 在建構時把那件事變成一個看得懂的例外了。上界買到的是**語意漂移**：欄位
// 名字與型別都沒變、意思變了，那種事沒有任何自動檢查抓得到。
//
// 唯一的驗證是那 25 道拿原生 Three 當對照組的關卡，而它們只跑過一個版本。
// 所以範圍就寫那一個版本，代價是 Three 每出一個 minor 就要發一版 ——
// 那是碰私有欄位的誠實價格。
const three = JSON.parse(readFileSync(join(ROOT, 'packages/three/package.json'), 'utf8'));
const peer = three.peerDependencies?.three;
check(
  typeof peer === 'string',
  `@web-world-engine/three 把 three 列為 peer —— ${peer ?? '（沒有）'}`,
);
check(
  typeof peer === 'string' && peer.includes('<'),
  `那個範圍有上界 —— ${peer}（關卡只驗過這個版本，語意漂移沒有自動檢查抓得到）`,
);

finish('發布欄位關卡');
