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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

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
  const source = readFileSync(join(root, file), 'utf8');
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

const three = exportedNames('packages/three/src/index.ts');
const format = exportedNames('packages/format/src/index.ts');
// `@webworld/three` 轉出了一部分 format 的東西，兩邊都算數。
const known = new Set([...three, ...format]);

console.log('文件裡寫的 API 真的存在嗎');
console.log(`  公開的名字：three ${three.size} 個、format ${format.size} 個`);

let failed = 0;
const missing = [];
let mentions = 0;

for (const doc of DOCS) {
  let text;
  try {
    text = readFileSync(join(root, doc), 'utf8');
  } catch {
    console.log(`  ✗ 讀不到 ${doc}`);
    failed++;
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

console.log(`  文件裡提到 ${mentions} 次`);
const unique = [...new Set(missing)];
if (unique.length > 0) {
  failed++;
  console.log(`  ✗ 有 ${unique.length} 個名字不存在：`);
  for (const one of unique) console.log(`      ${one}`);
} else {
  console.log('  ✓ 每一個都找得到');
}

// ## 反過來也要問：有沒有整個功能沒被寫進 README
//
// 少寫一個名字不會壞掉，但**使用者找不到的功能等於不存在**。這一輪
// 100 個公開名字裡有 76 個 README 一次都沒提過，包含每一個螢幕空間效果。
//
// 純型別（`FooOptions`、`FooStats`……）不算 —— 那些在編輯器裡自己會出現。
const readme = readFileSync(join(root, 'packages/three/README.md'), 'utf8');
const TYPE_ISH =
  /Options|Stats|Context|Placement|Rule|Chain|Source|Instance$|Target|Fn$|Tiles|Heightfield$|Wave|Body|Force|Rebasable|^Baked|^Cascaded/;
const undocumented = [...three].filter((n) => !TYPE_ISH.test(n) && !readme.includes(n));
if (undocumented.length > 0) {
  failed++;
  console.log(`  ✗ ${undocumented.length} 個公開的東西 README 沒提過：`);
  console.log(`      ${undocumented.join(' ')}`);
} else {
  console.log('  ✓ 每一個公開的功能 README 都寫到了');
}

console.log('');
if (failed > 0) {
  console.log(`文件關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('文件關卡：全過');
