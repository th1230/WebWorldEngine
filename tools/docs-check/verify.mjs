/**
 * README 裡寫的 API 真的存在嗎。
 *
 * ## 為什麼這也要一道關卡
 *
 * README 是使用者的第一個接觸點，而裡面每一個 `WW.something` 都是一句
 * **沒有任何東西守著的宣稱**。改名、改簽名、刪掉一個匯出 —— typecheck 過、
 * lint 過、807 個測試過、二十五道畫面關卡過，而文件裡那一行從此是錯的。
 *
 * 症狀最糟的地方在於它打擊的是**還沒有上手的人**：他照著文件寫，拿到
 * `undefined is not a function`，然後合理地推論這個套件是壞的。
 *
 * 這一輪寫文件時自己就踩了三次：`terrainHeightfield` 已經改名、
 * `PageTable.resident()` 根本不存在、`lodFade` 其實叫 `lodFadeBand`。
 * 三次都是憑印象寫的，三次都要回去對原始碼才發現。
 *
 * ## 判準
 *
 * 只問一件事：**文件裡以 `WW.` 開頭寫出來的名字，在 `index.ts` 的匯出裡
 * 找不找得到。**
 *
 * 刻意不驗簽名 —— 那要跑型別檢查，而範例是片段不是完整程式（`geometry`、
 * `renderer`、`material` 都沒有定義）。硬要驗的話得替每個片段編一份前言，
 * 那份前言自己又會過期。
 *
 * 名字這一層已經抓得到絕大多數的鏽：改名、刪除、打錯字。簽名改了而名字
 * 沒變的情況（這一輪的效果統一就是）靠 CHANGELOG 與 review。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from '../lib/repo-root.mjs';
import { startReport } from '../lib/report.mjs';

/** 掃哪些文件。 */
const DOCS = [
  'README.md',
  'CHANGELOG.md',
  'packages/three/README.md',
  'packages/format/README.md',
  'packages/cook/README.md',
  'apps/example/README.md',
  'specs/api.md',
];

/** `index.ts` 匯出的每一個名字。 */
function exportedNames(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const names = new Set();
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const one of block[1].split(',')) {
      const name = one
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  for (const one of source.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g,
  )) {
    names.add(one[1]);
  }
  return names;
}

/** 一個目錄底下所有的 .ts（不含測試）。 */
function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const three = exportedNames('packages/three/src/index.ts');
const format = exportedNames('packages/format/src/index.ts');
// `@webworld/three` 轉出了一部分 format 的東西，兩邊都算數。
const known = new Set([...three, ...format]);

const { check, note, finish } = startReport('文件裡寫的 API 真的存在嗎');
note(`公開的名字：three ${three.size} 個、format ${format.size} 個`);

const missing = [];
let mentions = 0;

for (const doc of DOCS) {
  let text;
  try {
    text = readFileSync(join(ROOT, doc), 'utf8');
  } catch {
    check(false, `讀不到 ${doc}`);
    continue;
  }
  // ## 只看程式碼區塊
  //
  // 圍籬裡的 `WW.foo` 是一句無歧義的宣稱：**照這樣寫**。散文裡的不是 ——
  // `specs/api.md` 的「還沒決定的事」那一節就在討論 `WW.Mesh` 要不要做，
  // 而它刻意還不存在。把那個當成錯誤的話，這道關卡會逼文件不准討論未來，
  // 那是關卡在改文件，不是在守文件。
  for (const fence of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const hit of fence[1].matchAll(/\bWW\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      mentions++;
      if (!known.has(hit[1])) missing.push(`${doc} → WW.${hit[1]}`);
    }
  }
}

note(`文件裡提到 ${mentions} 次`);
const unique = [...new Set(missing)];
check(
  unique.length === 0,
  `文件裡的每一個名字都找得到`,
  unique.join(String.fromCharCode(10) + `      `) || undefined,
);

// ## 反過來也要問：有沒有整個功能沒被寫進 README
//
// 少寫一個名字不會壞掉，但**使用者找不到的功能等於不存在**。這一輪
// 100 個公開名字裡有 76 個 README 一次都沒提過，包含每一個螢幕空間效果。
//
// 純型別（`FooOptions`、`FooStats`……）不算 —— 那些在編輯器裡自己會出現。
const readme = readFileSync(join(ROOT, 'packages/three/README.md'), 'utf8');
const TYPE_ISH =
  /Options|Stats|Context|Placement|Rule|Chain|Source|Instance$|Target|Fn$|Tiles|Heightfield$|Wave|Body|Force|Rebasable|^Baked|^Cascaded/;
const undocumented = [...three].filter((n) => !TYPE_ISH.test(n) && !readme.includes(n));
check(
  undocumented.length === 0,
  '每一個公開的功能 README 都寫到了',
  undocumented.length === 0
    ? undefined
    : `少了 ${undocumented.length} 個：${undocumented.join(' ')}`,
);

// ## 主控台訊息認得出是誰講的嗎
//
// 使用者在主控台看到一行字時要立刻知道兩件事：**誰講的**（是這個套件，
// 不是 Three，不是他自己的程式），以及**他呼叫的哪一支**。前者靠 `WW.` 前綴，
// 後者靠後面那個名字。
//
// 沒有前綴的訊息在一個真實專案的主控台裡是找不到來源的 —— 那裡同時有
// Three 的警告、打包器的、瀏覽器的、還有使用者自己的。
const MESSAGE_SOURCES = ['packages/three/src', 'packages/cook/src'];

// CLI 例外：那些字是講給**剛敲完指令的人**聽的，來源已經很明顯。
// 掛上 WW.cook: 只是噪音 —— 前綴是為了在一個混雜的主控台裡認出來源，
// 而終端機裡只有剛才那一行指令。
const CLI_ONLY = ['packages/cook/src/cli.ts'];
const unprefixed = [];
let messages = 0;
for (const dir of MESSAGE_SOURCES) {
  for (const file of walkTs(join(ROOT, dir))) {
    const text = readFileSync(file, 'utf8');
    // 兩種寫法都要看：單一字串，以及 `console.warn([…].join())` 的第一行 ——
    // 多行警告在這個套件裡很常見，而漏掉它們等於漏掉最長、最重要的那幾則。
    //
    // 只看**字面**開頭的那種。變數開頭的看不出前綴，而那一類本來就該把
    // 前綴寫在字面裡。
    for (const hit of text.matchAll(
      /(?:throw new Error|console\.(?:warn|error))\(\s*\[?\s*(['`])([^'`\n]{0,24})/g,
    )) {
      messages++;
      if (CLI_ONLY.some((one) => file.endsWith(one.split('/').join(sep)))) continue;
      if (!hit[2].startsWith('WW')) unprefixed.push(`${relative(ROOT, file)}：${hit[2]}…`);
    }
  }
}
note(`面向使用者的訊息 ${messages} 處`);
check(
  unprefixed.length === 0,
  '每一則都看得出是這個套件講的',
  unprefixed.length === 0
    ? undefined
    : `${unprefixed.length} 則沒有 WW 前綴：${String.fromCharCode(10)}      ${unprefixed.join(String.fromCharCode(10) + `      `)}`,
);

finish('文件關卡');
